param(
  [Parameter(Mandatory = $true)][string]$Package,
  [int]$TimeoutSeconds = 1200
)

$ErrorActionPreference = "Stop"
$Package = (Resolve-Path -LiteralPath $Package).Path
$runnerTemp = $env:RUNNER_TEMP
if ([string]::IsNullOrWhiteSpace($runnerTemp) -or !(Test-Path -LiteralPath $runnerTemp -PathType Container)) {
  throw "RUNNER_TEMP must name an existing temporary directory."
}
$runnerTemp = (Resolve-Path -LiteralPath $runnerTemp).Path.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$exe = Join-Path $Package "Clipflow.exe"
$ffmpeg = Join-Path $Package "resources\ffmpeg\ffmpeg.exe"
$ffprobe = Join-Path $Package "resources\ffmpeg\ffprobe.exe"
foreach ($path in @($exe, $ffmpeg, $ffprobe)) {
  if (!(Test-Path -LiteralPath $path)) { throw "Packaged smoke prerequisite is missing: $path" }
}

$temp = Join-Path $env:RUNNER_TEMP ("clipflow-smoke-" + [guid]::NewGuid().ToString("N"))
$tempFull = [IO.Path]::GetFullPath($temp)
if (!$tempFull.StartsWith($runnerTemp, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Smoke temp path must remain under RUNNER_TEMP: $tempFull"
}
$source = Join-Path $temp "synthetic.mp4"
$output = Join-Path $temp "export.mp4"
$handoff = Join-Path $temp "adobe-handoff.zip"
$port = Get-Random -Minimum 18000 -Maximum 28000
$previousLocalAppData = $env:LOCALAPPDATA
$previousNoDialog = $env:CLIPFLOW_NO_DIALOG
$env:LOCALAPPDATA = Join-Path $temp "local-app-data"
$env:CLIPFLOW_NO_DIALOG = "1"
New-Item -ItemType Directory -Path $temp -Force | Out-Null
$process = $null

function Wait-Job([string]$Id, [string]$Api, [int]$Seconds) {
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  $stages = [System.Collections.Generic.HashSet[string]]::new()
  do {
    $job = Invoke-RestMethod -Uri "$Api/api/jobs/$Id" -TimeoutSec 15
    if ($job.stage) { [void]$stages.Add([string]$job.stage) }
    if ($job.status -eq "done") { return @{ Job = $job; Stages = $stages } }
    if ($job.status -in @("error", "cancelled")) {
      throw "Packaged job '$($job.kind)' $($job.status): $($job.error) (stage: $($job.stage))"
    }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Timed out waiting for packaged job $Id (last stage: $($job.stage))"
}

try {
  # A real audio stream forces automatic captions through bundled Whisper and Silero.
  & $ffmpeg -hide_banner -loglevel error -y -f lavfi -i "testsrc2=size=320x180:rate=24:duration=8" -f lavfi -i "sine=frequency=440:sample_rate=16000:duration=8" -shortest -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 64k $source
  if ($LASTEXITCODE -ne 0) { throw "Could not create the 8-second synthetic MP4." }

  $process = Start-Process -FilePath $exe -ArgumentList @("--serve", "--port", "$port") -PassThru -WindowStyle Hidden
  $api = "http://127.0.0.1:$port"
  $deadline = [DateTime]::UtcNow.AddSeconds(90)
  do {
    if ($process.HasExited) { throw "Packaged Clipflow.exe exited during startup with code $($process.ExitCode)." }
    try { $health = Invoke-RestMethod -Uri "$api/api/health" -TimeoutSec 3; break } catch { Start-Sleep -Milliseconds 500 }
  } while ([DateTime]::UtcNow -lt $deadline)
  if (!$health) { throw "Packaged Clipflow.exe did not become API-ready." }
  if (!$health.transcription) { throw "The packaged API reports local transcription unavailable." }
  if (!$health.ffmpeg -or !$health.ffprobe) { throw "The packaged API reports FFmpeg/FFprobe unavailable." }

  $upload = & curl.exe --silent --show-error --fail -F "file=@$source;type=video/mp4" -F "target_duration=5" "$api/api/projects/upload" | ConvertFrom-Json
  if (!$upload.project_id -or !$upload.id) { throw "Upload did not return the expected project and job IDs." }
  [void](Wait-Job $upload.id $api $TimeoutSeconds)

  $payload = @{
    automatic = $true; mode = "smart"; max_clips = 1; target_duration = 5; use_transcript = $true
    captions = @{ mode = "auto"; quality = "auto"; language = "auto" }
    camera = @{ aspect_ratio = "9:16"; resolution = 720 }
  } | ConvertTo-Json -Depth 6
  $generation = Invoke-RestMethod -Method Post -Uri "$api/api/projects/$($upload.project_id)/generate" -ContentType "application/json" -Body $payload
  $generated = Wait-Job $generation.id $api $TimeoutSeconds
  $joinedStages = $generated.Stages -join " | "
  $project = Invoke-RestMethod -Uri "$api/api/projects/$($upload.project_id)"
  $clip = $project.clips | Where-Object { $_.selected } | Select-Object -First 1
  if (!$clip) { throw "Automatic generation produced no selected clips." }
  $export = Invoke-RestMethod -Method Post -Uri "$api/api/projects/$($upload.project_id)/export" -ContentType "application/json" -Body (@{ clip_ids = @($clip.id) } | ConvertTo-Json)
  [void](Wait-Job $export.id $api $TimeoutSeconds)
  Invoke-WebRequest -Uri "$api/api/projects/$($upload.project_id)/clips/$($clip.id)/download" -OutFile $output -TimeoutSec 60
  $probe = & $ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height -of json $output | ConvertFrom-Json
  $video = $probe.streams | Select-Object -First 1
  if ($video.codec_name -ne "h264" -or $video.width -ne 720 -or $video.height -ne 1280) {
    throw "Export is not playable H.264 720x1280 (got $($video.codec_name) $($video.width)x$($video.height))."
  }
  Invoke-WebRequest -Uri "$api/api/projects/$($upload.project_id)/edit-package?clip_ids=$($clip.id)" -OutFile $handoff -TimeoutSec 60
  Add-Type -AssemblyName System.IO.Compression.ZipFile
  $archive = [System.IO.Compression.ZipFile]::OpenRead($handoff)
  try {
    $names = @($archive.Entries | ForEach-Object FullName)
    foreach ($expected in @("Premiere.xml", "after-effects.jsx", "captions.srt", "manifest.json", "README.txt", "media/synthetic.mp4")) {
      if ($expected -notin $names) { throw "Adobe edit package is missing $expected." }
    }
    if (@($names | Where-Object { $_ -eq "media/synthetic.mp4" }).Count -ne 1) {
      throw "Adobe edit package must include the source exactly once."
    }
    $xmlStream = $archive.GetEntry("Premiere.xml").Open()
    try {
      $reader = [IO.StreamReader]::new($xmlStream)
      try { [xml]$timeline = $reader.ReadToEnd() } finally { $reader.Dispose() }
    } finally { $xmlStream.Dispose() }
    if ($timeline.xmeml.sequence.media.video.track.clipitem.Count -ne 1) {
      throw "Adobe edit package did not contain the selected clip timeline."
    }
  } finally { $archive.Dispose() }
  Write-Host "Fresh-package smoke passed: automatic speech generation completed (observed stages: $joinedStages); export $($video.codec_name) $($video.width)x$($video.height); editable handoff ZIP verified."
} finally {
  if ($process -and !$process.HasExited) {
    Stop-Process -Id $process.Id -Force
    [void]$process.WaitForExit(10000)
  }
  if ($null -eq $previousLocalAppData) { Remove-Item Env:\LOCALAPPDATA -ErrorAction SilentlyContinue } else { $env:LOCALAPPDATA = $previousLocalAppData }
  if ($null -eq $previousNoDialog) { Remove-Item Env:\CLIPFLOW_NO_DIALOG -ErrorAction SilentlyContinue } else { $env:CLIPFLOW_NO_DIALOG = $previousNoDialog }
  Remove-Item -LiteralPath $tempFull -Recurse -Force -ErrorAction Stop
  if (Test-Path -LiteralPath $temp) { throw "Could not clean temporary smoke data: $temp" }
}
