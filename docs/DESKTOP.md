# Clipflow Desktop for Windows

Clipflow Desktop is an optional distributable wrapper around the existing
local FastAPI service and React editor. It runs the API on a random
`127.0.0.1` port and displays it in the Windows WebView2 runtime. Projects,
media, exports, and provider settings stay per-user under
`%LOCALAPPDATA%\Clipflow`; credentials are never bundled in the executable.

## Build a portable folder

From the repository root in PowerShell:

```powershell
pwsh desktop/build.ps1
```

This creates `build/desktop/Clipflow/Clipflow.exe` and
`build/desktop/Clipflow-windows-x64.zip`. The build uses the existing
frontend bundle and backend package, and installs only `pywebview` and
`PyInstaller` in the selected Python environment. It includes the local
FFmpeg tools by default:

```powershell
pwsh desktop/build.ps1
```

The FFmpeg build is large. For a source-only deployment, use
`pwsh desktop/build.ps1 -WithoutFfmpeg` and put `ffmpeg.exe` and `ffprobe.exe`
in a tools folder, then set `CLIPFLOW_FFMPEG_DIR` before starting.

The package is an onedir folder: zip the complete `Clipflow` directory for
distribution (the build script creates this ZIP by default) and keep its
contents together after extraction. WebView2 is a Windows system runtime and
is not copied into the package.

The selected Python environment must already contain the backend requirements;
the build checks imports for FastAPI, Uvicorn, OpenCV, faster-whisper, and
yt-dlp before freezing. Install `backend/requirements.txt` there first.

## Run and verify

Double-click `Clipflow.exe`, or run `Clipflow.exe --self-test` for a headless
API check. The self-test starts the same local service and verifies
`/api/health`, then exits. A source checkout can run the wrapper with
`python -m desktop.launcher --headless` after installing the desktop and backend
requirements.

The editor's Settings page accepts optional Groq or Higgsfield keys. Local
transcription remains the default; its speech model is downloaded on first
use when the user chooses it, and models are kept outside the package.

## Troubleshooting startup

The desktop wrapper records startup events and tracebacks at
`%LOCALAPPDATA%\Clipflow\logs\desktop.log`. If the embedded WebView2 window
cannot initialize, Clipflow opens the same local service in the default browser
and keeps its API process running. The startup dialog shows the browser URL and
the log path; keep the Clipflow process running while using that browser tab.

The package includes the WebView2 loader DLL, but Windows still needs the
WebView2 Runtime installed. The browser fallback remains available on machines
where the runtime or its .NET integration is unavailable.

## Packaging boundaries

The portable package excludes `.env`, user media, project databases, model
caches, licensed Neue Einstellung fonts, and generated exports. The bundled
Outfit font is distributed under its existing OFL license. Runtime credentials
are written only to the per-user settings file and are not returned to the UI.

The default build copies the FFmpeg and FFprobe binaries found on the builder's
`PATH` and writes FFmpeg's `-L` license notice beside them as
`resources/ffmpeg/FFmpeg-LICENSE.txt`. The exact binary build and its license
terms are therefore visible in each artifact; distributors should retain that
notice and provide the corresponding FFmpeg source or source offer required by
the binary's LGPL/GPL configuration.
