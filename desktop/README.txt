Clipflow Desktop

Run Clipflow.exe. It opens a private local window and keeps projects in:
  %LOCALAPPDATA%\Clipflow\data

Provider keys and settings are saved in:
  %LOCALAPPDATA%\Clipflow\settings.env

The package includes the editor, API, and FFmpeg/FFprobe. A smaller build can
be made with build.ps1 -WithoutFfmpeg; set CLIPFLOW_FFMPEG_DIR to a folder
containing ffmpeg.exe and ffprobe.exe before launching that build.

The desktop process only listens on 127.0.0.1 and chooses a random port.
WebView2 (the Edge runtime) is required by pywebview on Windows 10/11.

The supported build command creates both the portable folder and
Clipflow-windows-x64.zip. Use -WithoutZip when only the folder is needed.
