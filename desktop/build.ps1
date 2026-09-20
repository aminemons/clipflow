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
& $Python -c "import fastapi, uvicorn, cv2, faster_whisper, yt_dlp"
if ($LASTEXITCODE) {
  throw "Backend dependencies are missing. Install backend/requirements.txt in the selected Python environment before building."
}

Push-Location $Repo
try {
  if (!(Test-Path "frontend\\node_modules")) { npm --prefix frontend ci }
  npm --prefix frontend run build
  if ($LASTEXITCODE) { throw "Frontend build failed." }
  Remove-Item $Out -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Path $Out,$Work -Force | Out-Null
  # Vite copies public fonts into dist. Stage a portable copy that removes
  # private Neue Einstellung files and points the generated CSS at Outfit.
  $FrontendStage = Join-Path $Work "frontend-dist"
  New-Item -ItemType Directory -Path $FrontendStage -Force | Out-Null
  Copy-Item -Path (Join-Path $Repo "frontend\dist\*") -Destination $FrontendStage -Recurse -Force
  Get-ChildItem -LiteralPath $FrontendStage -Recurse -File | ForEach-Object {
    if ($_.Extension -in @('.css', '.js', '.html')) {
      $text = Get-Content -LiteralPath $_.FullName -Raw
      $text = $text -replace 'NeueEinstellung-[A-Za-z]+\.woff2', 'Outfit.ttf'
      $text = $text -replace 'font-family:Neue', 'font-family:Outfit'
      Set-Content -LiteralPath $_.FullName -Value $text -Encoding UTF8
    }
  }
  Get-ChildItem -LiteralPath $FrontendStage -Recurse -File -Filter 'NeueEinstellung-*.woff2' | Remove-Item -Force
  $args = @(
    "--noconfirm", "--clean", "--onedir", "--name", "Clipflow",
    "--distpath", $Out, "--workpath", $Work,
    "--add-data", "$FrontendStage;frontend\\dist",
    "--hidden-import", "backend.app",
    "--hidden-import", "backend.settings", "--hidden-import", "backend.generation",
    "--hidden-import", "backend.export_artifacts", "--collect-submodules", "backend",
    "desktop\\launcher.py"
  )
  & $Python -m PyInstaller @args
  if ($LASTEXITCODE) { throw "PyInstaller failed." }

  $Resources = Join-Path $Out "Clipflow\\resources"
  New-Item -ItemType Directory -Path $Resources -Force | Out-Null
  if (!$WithoutFfmpeg) {
    $ffmpeg = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source
    $ffprobe = (Get-Command ffprobe -ErrorAction SilentlyContinue).Source
    if (!$ffmpeg -or !$ffprobe) { throw "-WithFfmpeg requires ffmpeg.exe and ffprobe.exe on PATH." }
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
