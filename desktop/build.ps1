param(
  [string]$Python = "python",
  [string]$Output = "build\desktop",
  [switch]$WithoutFfmpeg,
  [switch]$WithoutZip
)

$ErrorActionPreference = "Stop"
$Repo = (Resolve-Path (Join-Path $PSScriptRoot ".."))
$Out = Join-Path $Repo $Output
$Work = Join-Path $Repo "build\desktop-work"

function Assert-UnderRepo([string]$Path, [string]$Label) {
  $repoFull = [IO.Path]::GetFullPath($Repo.Path).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $pathFull = [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar)
  if (!$pathFull.StartsWith($repoFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label must stay under the repository: $Path"
  }
}

Assert-UnderRepo $Out "Output"
Assert-UnderRepo $Work "Work path"

Write-Host "Building Clipflow desktop from $Repo"
& $Python -m pip install -r (Join-Path $PSScriptRoot "requirements.txt")
if ($LASTEXITCODE) { throw "Desktop build dependencies failed to install." }
& $Python -c "import fastapi, uvicorn, cv2, curl_cffi, faster_whisper, yt_dlp"
if ($LASTEXITCODE) {
  throw "Backend dependencies are missing. Install backend/requirements.txt in the selected Python environment before building."
}

Push-Location $Repo
try {
  npm --prefix frontend ci
  if ($LASTEXITCODE) { throw "Frontend dependency installation failed." }
  npm --prefix frontend run build
  if ($LASTEXITCODE) { throw "Frontend build failed." }
  Remove-Item $Out -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Path $Out,$Work -Force | Out-Null
  # Vite copies the bundled OFL fonts into dist. Stage a portable copy.
  $FrontendStage = Join-Path $Work "frontend-dist"
  New-Item -ItemType Directory -Path $FrontendStage -Force | Out-Null
  Copy-Item -Path (Join-Path $Repo "frontend\dist\*") -Destination $FrontendStage -Recurse -Force
  $args = @(
    "--noconfirm", "--clean", "--onedir", "--name", "Clipflow",
    "--distpath", $Out, "--workpath", $Work,
    "--add-data", "$FrontendStage;frontend\\dist",
    "--hidden-import", "backend.app",
    "--hidden-import", "backend.settings", "--hidden-import", "backend.generation",
    "--hidden-import", "backend.export_artifacts", "--collect-submodules", "backend",
    # faster-whisper loads Silero VAD models by filename at runtime. PyInstaller
    # sees the Python import but cannot infer these ONNX data files.
    "--collect-all", "faster_whisper",
    "--collect-all", "onnxruntime",
    "--collect-all", "curl_cffi",
    "--collect-all", "yt_dlp_ejs",
    "desktop\\launcher.py"
  )
  & $Python -m PyInstaller @args
  if ($LASTEXITCODE) { throw "PyInstaller failed." }

  $Resources = Join-Path $Out "Clipflow\\resources"
  New-Item -ItemType Directory -Path $Resources -Force | Out-Null
  $ModelDir = Join-Path $Resources "models\\small"
  & $Python -m desktop.download_model --model small --output $ModelDir
  if ($LASTEXITCODE) { throw "Bundled speech model download failed." }
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (!$node) { throw "Node.js was not found on PATH. Install Node.js before building the desktop package." }
  $NodeDir = Join-Path $Resources "node"
  New-Item -ItemType Directory -Path $NodeDir -Force | Out-Null
  Copy-Item $node (Join-Path $NodeDir "node.exe") -Force
  $NodeVersion = (& $node --version).Trim()
  try {
    Invoke-WebRequest -Uri "https://raw.githubusercontent.com/nodejs/node/$NodeVersion/LICENSE" -OutFile (Join-Path $NodeDir "Node-LICENSE.txt") -UseBasicParsing
  } catch {
    throw "Could not fetch the matching Node.js $NodeVersion license notice."
  }
  if (!$WithoutFfmpeg) {
    $ffmpeg = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source
    $ffprobe = (Get-Command ffprobe -ErrorAction SilentlyContinue).Source
    if (!$ffmpeg -or !$ffprobe) { throw "FFmpeg and FFprobe were not found on PATH. Install them or rerun with -WithoutFfmpeg." }
    $FfmpegDir = Join-Path $Resources "ffmpeg"
    New-Item -ItemType Directory -Path $FfmpegDir -Force | Out-Null
    Copy-Item $ffmpeg,$ffprobe $FfmpegDir
    # Preserve the complete license notice alongside the redistributable tools.
    $licenseInfo = New-Object System.Diagnostics.ProcessStartInfo
    $licenseInfo.FileName = $ffmpeg
    $licenseInfo.Arguments = "-L"
    $licenseInfo.UseShellExecute = $false
    $licenseInfo.CreateNoWindow = $true
    $licenseInfo.RedirectStandardOutput = $true
    $licenseInfo.RedirectStandardError = $true
    $licenseProcess = [System.Diagnostics.Process]::Start($licenseInfo)
    $licenseText = $licenseProcess.StandardOutput.ReadToEnd() + "`r`n" + $licenseProcess.StandardError.ReadToEnd()
    $licenseProcess.WaitForExit()
    $licenseText | Set-Content -LiteralPath (Join-Path $FfmpegDir "FFmpeg-LICENSE.txt") -Encoding UTF8
  }
  Copy-Item (Join-Path $PSScriptRoot "README.txt") (Join-Path $Out "Clipflow")
  $VerifyArgs = @((Join-Path $Out "Clipflow"))
  if ($WithoutFfmpeg) { $VerifyArgs += "--without-ffmpeg" }
  & $Python -m desktop.verify_bundle @VerifyArgs
  if ($LASTEXITCODE) { throw "Desktop bundle verification failed." }
  if (!$WithoutZip) {
    $Zip = Join-Path $Out "Clipflow-windows-x64.zip"
    Assert-UnderRepo $Zip "Zip path"
    Remove-Item -LiteralPath $Zip -Force -ErrorAction SilentlyContinue
    Compress-Archive -Path (Join-Path $Out "Clipflow") -DestinationPath $Zip -CompressionLevel Fastest
    Write-Host "Built $Zip"
  }
  Write-Host "Built $Out\\Clipflow\\Clipflow.exe"
} finally {
  Pop-Location
}
