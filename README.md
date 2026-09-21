# Clipflow

Clipflow is a local-first video editor for turning long recordings into short, captioned clips. It combines a React/Vite editor with a FastAPI worker, FFmpeg rendering, OpenCV framing, local Whisper transcription, and yt-dlp imports.

The normal flow is explicit: create or open a project, import a local file or inspect and download a YouTube source, choose a clip setup, review the suggested clips, then edit and export. Importing a source does not silently analyze it.

## What it does

- Imports local video files and selected YouTube sources.
- Creates clips from a full source, transcript moments, or manual ranges.
- Provides local smart highlights, transcript editing, captions, speed, mute, fades, denoise, and crop/follow framing.
- Renders MP4 clips with H.264 video, AAC audio, burned captions, and SRT downloads where selected.
- Exports individual clips or a ZIP batch.
- Offers optional provider integrations for hosted transcription, text ranking, vision framing, generative B-roll, and publishing. Each provider is opt-in from Settings and uses the account or credentials supplied by the owner.

## Free path and optional providers

Local mode needs no account or paid API key. OpenCV framing, local highlight ranking, FFmpeg rendering, and on-device Whisper transcription run on the machine. The selected Whisper model is downloaded on first use and needs free disk space; Fast/tiny is an option on modest hardware; larger models take more time and memory.

Groq can provide hosted transcription or highlight ranking. OpenAI, Anthropic, Gemini, and Ollama options are available for the provider features implemented in Settings. Higgsfield is an optional generative B-roll integration. Publishing integrations need their own OAuth or provider setup. The supplied deployment has no paid provider configured, and no provider account or credits are included with Clipflow.

## Run locally

Prerequisites:

- Python 3.11 or newer
- Node.js 20 or newer with `npm`
- FFmpeg and FFprobe on `PATH`
- Several GB of free disk space for dependencies, source media, renders, and Whisper models

From the repository root, use PowerShell on Windows:

```powershell
python launch.py
```

On macOS or Linux, use the same launcher with the available Python command, usually:

```sh
python3 launch.py
```

`start.cmd` is a Windows convenience wrapper for `python launch.py`.

The launcher creates `.env` from `.env.example`, creates `.venv`, installs `backend/requirements.txt`, builds the frontend, and opens `http://127.0.0.1:8767`. Keep the terminal open while using the editor. Useful options are `python launch.py --no-browser`, `python launch.py --port 9000`, and `python launch.py --rebuild`.

Set `CLIPFLOW_DATA` and `CLIPFLOW_MODEL_CACHE` in `.env` when the default drive does not have enough space. Local mode is the default and does not require Supabase settings. A local Docker smoke environment is also available with:

```powershell
docker compose up --build
```

It serves the editor at `http://127.0.0.1:8767` and keeps project data in the named `clipflow-data` volume.

## Hosted deployment

The current hosted shape is an owner-only workspace:

- Vercel serves the Vite frontend and rewrites relative `/api` and `/media` requests.
- An Azure VM runs one persistent Dockerized FastAPI worker behind Caddy HTTPS.
- Supabase Auth verifies the single configured owner. Supabase Storage is not used; projects, source media, renders, and settings remain on the worker's persistent disk.

The hosted frontend is [clipflow-aminemons.vercel.app](https://clipflow-aminemons.vercel.app). Access is restricted to the configured owner account. Hosted deployment files and the required environment shape are in [docs/HOSTING.md](docs/HOSTING.md) and `deploy/azure/`. Never put Supabase service credentials or provider secrets in Vite variables or committed files.

This deployment is intentionally single-owner and single-worker. A worker restart signs out the in-memory hosted session and interrupts jobs that were running. It is not a multi-user or horizontally scaled service.

## Architecture

The frontend is a Vite-built React application served by the FastAPI process in local mode and by Vercel in the hosted layout. FastAPI stores project metadata and job records as JSON under `CLIPFLOW_DATA`; media and exports are files in the same workspace. Writes use temporary files and replacement, with small backups for project records. An in-process executor runs one job at a time and mirrors job state to disk.

This keeps the local and owner-hosted paths simple, but it also means large uploads, renders, model downloads, and free disk space are bounded by the worker. A restart does not resume queued or running work. OpenCV tracking is heuristic and can need manual framing on graphic-heavy footage, while local Whisper accuracy depends on the audio and language. YouTube imports depend on the source being available to yt-dlp. YouTube may reject a cloud server with an anti-bot check even for a public video; upload your own video file if that happens.

## Desktop build

The optional Windows wrapper and portable ZIP instructions are in [docs/DESKTOP.md](docs/DESKTOP.md). The package keeps each user's projects, media, exports, and settings under `%LOCALAPPDATA%\\Clipflow`; it does not bundle `.env`, user data, models, or private fonts. WebView2 is required, with a browser fallback when its runtime is unavailable.

## Validation

The dated validation record in [docs/VALIDATION.md](docs/VALIDATION.md) separates automated checks, real workflow checks, and remaining deployment evidence. It records the exact test counts and the provider, model, browser, and hosted limitations that still matter.

After the launcher has installed the app, run these checks in PowerShell:

```powershell
.venv\Scripts\python -m pip install pytest
.venv\Scripts\python -m compileall backend launch.py
Push-Location frontend
npm ci
npm run build
npm test
Pop-Location
.venv\Scripts\python -m pytest -q
```

Use [docs/RELEASE-CHECKLIST.md](docs/RELEASE-CHECKLIST.md) for the remaining owner-hosted and distribution checks.
