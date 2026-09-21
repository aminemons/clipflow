# Clipflow

Clipflow turns a horizontal recording into editable vertical clips. It was
built for a full-stack engineering exercise, so the complete path works on a
local machine without an account or paid API: import, choose moments, reframe,
caption, review, and export.

The editor does not hide long-running work. Uploads, transcription, previews,
and exports run as jobs with visible progress and recoverable errors. Importing
a source also stays separate from generating clips, which makes it safe to
review every choice before processing starts.

## Run it on Windows

Install Python 3.11+, Node.js 20+, and FFmpeg. Then run this from the repository
root in PowerShell:

```powershell
python launch.py
```

The launcher creates a virtual environment, installs the Python and JavaScript
dependencies, builds the frontend, and opens `http://127.0.0.1:8767`. Keep the
terminal open while using Clipflow.

For a clean dependency or frontend rebuild:

```powershell
python launch.py --rebuild
```

On macOS and Linux, run `python3 launch.py`. Docker users can instead run
`docker compose up --build` and open the same port.

## First project

1. Choose **New project** and upload an MP4, MOV, or WebM file. A public YouTube
   link can also be inspected and imported.
2. In **Clip setup**, choose smart highlights, full-source splitting, or manual
   ranges. Set the target clip length before generating.
3. Open a generated clip. Trim it on the timeline, choose the camera behavior,
   correct its transcript, and place the captions.
4. Save the draft and choose **Render preview**. This proof contains the real
   crop, tracking, captions, speed, and audio effects.
5. Export the open clip, or check several clips in the library and export a ZIP.

The Windows package includes the multilingual Small speech model, so its
default automatic-clipping path works offline. A source checkout downloads a
selected Whisper model once; choosing another model in the desktop package does
the same. The Fast setting has the smallest memory requirement.

## Main features

- Local file upload and public YouTube import with bounded retry and clean
  recovery when YouTube rejects a server connection.
- Smart, full-source, and manual clip generation with target duration,
  tolerance, topic, and clip-count controls.
- A zoomable source timeline with independent active-clip and batch-export
  selection.
- Face or subject-following vertical framing, manual camera positions,
  keyframes, fit, and blurred-background layouts.
- Local Whisper or optional Groq transcription, transcript correction, SRT/VTT
  import, draggable captions, and SRT download.
- Speed, volume, mute, denoise, and audio fades.
- Rendered proofs, individual MP4 exports, ZIP batches, immutable downloads,
  delete/restore, and project persistence.

Optional provider settings exist for hosted transcription, highlight ranking,
vision framing, B-roll, and publishing. They are outside the free local path and
only run after the owner supplies the relevant credentials.

## How it is built

The React/Vite frontend talks to a FastAPI service. FFmpeg handles media
conversion and export, OpenCV provides local framing analysis, faster-whisper
provides on-device speech recognition, and yt-dlp handles supported YouTube
sources. Project and job records are stored as JSON beside their media files.
Writes use temporary files and replacement, and one in-process worker runs media
jobs sequentially so a small machine is not overloaded.

More detail is available in [the architecture notes](docs/ARCHITECTURE.md).

## Tests

Run the same checks used before a release:

```powershell
.venv\Scripts\python -m pip install pytest
.venv\Scripts\python -m compileall backend desktop launch.py
.venv\Scripts\python -m pytest backend/tests desktop/tests tests -q
Push-Location frontend
npm ci
npm run build
npm test
Pop-Location
```

The integration suite generates real video and audio with FFmpeg, then checks
upload, clip creation, preview rendering, caption output, MP4 export, ZIP export,
delete/restore, and persisted state. The exact release evidence is recorded in
[docs/VALIDATION.md](docs/VALIDATION.md).

## Windows desktop package

The portable Windows build keeps projects and settings under
`%LOCALAPPDATA%\Clipflow`. Build it from PowerShell with:

```powershell
pwsh desktop/build.ps1
```

The script creates `build/desktop/Clipflow-windows-x64.zip`. It downloads a
pinned copy of the multilingual Small model, then verifies the bundled frontend,
FFmpeg, Node.js, ONNX Runtime, browser-compatible YouTube transport, model, and
faster-whisper VAD file before creating the ZIP. See
[docs/DESKTOP.md](docs/DESKTOP.md) for packaging and licensing details.

## Hosted workspace

The hosted demo uses Vercel for the frontend and one persistent FastAPI worker.
It is an owner-only workspace rather than a multi-user service. A public YouTube
video can still be rejected when YouTube challenges the worker's datacenter IP;
Clipflow retries once with yt-dlp's browser-compatible transport, then offers
desktop or file upload instead of leaving a failed job running.

Deployment configuration is documented in [docs/HOSTING.md](docs/HOSTING.md).
Secrets belong in the host configuration and must never be committed or exposed
through Vite environment variables.

Before sharing a build, complete [the release checklist](docs/RELEASE-CHECKLIST.md).
