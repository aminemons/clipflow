Clipflow Desktop

Run Clipflow.exe. It opens a private local window and keeps projects in:
  %LOCALAPPDATA%\Clipflow\data

Provider keys and settings are saved in:
  %LOCALAPPDATA%\Clipflow\settings.env

The package includes the editor, API, multilingual Small speech model,
FFmpeg/FFprobe, and the Node.js runtime used by yt-dlp, with their source and
license notices. A smaller build can be made with build.ps1 -WithoutFfmpeg; set
CLIPFLOW_FFMPEG_DIR to a folder containing ffmpeg.exe and ffprobe.exe before
launching that build.

Local transcription needs no paid API key. The included Small model works
offline. If you explicitly choose another model, Clipflow downloads it once and
stores it under your local application data.

The desktop process only listens on 127.0.0.1 and chooses a random port.
WebView2 (the Edge runtime) is required by pywebview on Windows 10/11.

When started, the packaged Windows app registers the clipflow:// import link for
the current Windows user. A YouTube import opened from Clipflow's website runs
on this computer's internet connection, saves a temporary MP4 (up to 500 MB),
then uploads it to the Clipflow server and opens the new project. The one-use
import link expires; create a fresh link if the desktop reports that it expired.
Import diagnostics are in %LOCALAPPDATA%\Clipflow\logs\desktop.log.

Self-hosters can set CLIPFLOW_TRUSTED_WORKER_ORIGINS and
CLIPFLOW_TRUSTED_WEB_ORIGINS to comma-separated HTTPS origins before launching
Clipflow. The defaults trust only the official Clipflow worker and website.

The supported build command creates both the portable folder and
Clipflow-windows-x64.zip. Use -WithoutZip when only the folder is needed.
