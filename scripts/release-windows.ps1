param(
  [string]$Python = ".venv\Scripts\python.exe",
  [switch]$SkipDesktop
)

$ErrorActionPreference = "Stop"
$Repo = (Resolve-Path (Join-Path $PSScriptRoot ".."))

if (!(Test-Path -LiteralPath (Join-Path $Repo $Python))) {
  throw "Python environment not found at $Python. Run 'python launch.py --rebuild' first."
}

Push-Location $Repo
try {
  & $Python -m pip install -r backend\requirements.txt -r desktop\requirements.txt pytest
  if ($LASTEXITCODE) { throw "Python dependency installation failed." }

  & $Python -m compileall backend desktop launch.py
  if ($LASTEXITCODE) { throw "Python compilation failed." }

  & $Python -m pytest backend\tests desktop\tests tests -q
  if ($LASTEXITCODE) { throw "Python tests failed." }

  npm --prefix frontend ci
  if ($LASTEXITCODE) { throw "Frontend dependency installation failed." }

  npm --prefix frontend test
  if ($LASTEXITCODE) { throw "Frontend tests failed." }

  npm --prefix frontend run build
  if ($LASTEXITCODE) { throw "Frontend build failed." }

  if ($SkipDesktop) {
    Write-Host "Source validation passed. Desktop build was skipped."
    exit 0
  }

  & .\desktop\build.ps1 -Python $Python
  if ($LASTEXITCODE) { throw "Desktop build failed." }

  $Executable = Join-Path $Repo "build\desktop\Clipflow\Clipflow.exe"
  $Archive = Join-Path $Repo "build\desktop\Clipflow-windows-x64.zip"
  & $Executable --self-test
  if ($LASTEXITCODE) { throw "Packaged desktop self-test failed." }

  $Hash = Get-FileHash -Algorithm SHA256 -LiteralPath $Archive
  $Size = [Math]::Round((Get-Item -LiteralPath $Archive).Length / 1MB, 1)
  Write-Host "Release checks passed."
  Write-Host "Archive: $Archive"
  Write-Host "Size: $Size MB"
  Write-Host "SHA256: $($Hash.Hash)"
} finally {
  Pop-Location
}
