# Clipflow

Turn long horizontal videos into vertical clips, then review, edit, caption, and export them.

Clipflow was built for a full-stack developer assessment. The core workflow uses free, open-source tools and runs locally without an account or paid API key. A hosted workspace and optional external providers are also available.

## Try the hosted version

Open **[Clipflow](https://clipflow-aminemons.vercel.app)** and sign in with the assessment account:

```text
Email:    boubasala2009@gmail.com
Password: wpq3Z3E8KmEDpEyWsh4Du-i6l4p8Mb4s
```

This is a shared assessment workspace. Anyone using these credentials can view, change, or delete its projects. Use a non-private sample video. The local application does not require an account.

To test the complete workflow, start with a short horizontal MP4:

1. Choose **New project**, upload the video, and check its source preview.
2. Choose **Create clips automatically** to get editable suggestions. To test manual control instead, configure moments, camera, and captions before selecting **Generate clips**.
3. Open a suggestion, rename it, adjust its start or end, and change a caption or camera setting.
4. Save the edit and render a preview; source playback alone does not show the final crop or effects.
5. Export one MP4, then select multiple clips and download their ZIP.
6. Return to **Projects** and permanently delete the test project if you no longer need it.

Review automatic suggestions before exporting. For a quick offline check, download the Windows package from the site's sidebar, extract the full folder, and repeat the upload-to-export flow without signing in.

If the source already has a timed text subtitle track, automatic setup reuses it instead of running speech recognition. For captions burned into the picture, select **Video already has visible captions** before automatic clipping to avoid placing another layer of text over them. Burned-in text cannot be identified reliably from the video metadata alone.

### What runs online?

The browser provides the editor. An Azure worker processes uploads, analyzes footage, transcribes audio, renders previews, and generates exports. You do not need Python, FFmpeg, or a local speech model to use the hosted workspace.

The web version supports the same core editing workflow as the local application. Optional provider features require credentials on the hosted worker.

YouTube sometimes blocks requests from datacenter IP addresses. If a link cannot be imported, upload the original video file or try the desktop application. Desktop imports can also be subject to YouTube restrictions.

## Use the Windows desktop application

Sign in to the hosted site and choose **Download desktop** in the sidebar. Extract the **entire folder** from the ZIP and run:

```text
Clipflow\Clipflow.exe
```

Keep the executable and its accompanying files together. No separate Python, Node.js, or FFmpeg installation is needed for the packaged application.

The desktop application starts its own local service and opens the editor in a Windows WebView2 window. If that window cannot start, the launcher can open the editor in your default browser.

Projects, exports, models, and settings are stored under:

```text
%LOCALAPPDATA%\Clipflow
```

### Offline or connected

For offline use, upload a local video and keep transcription, highlight selection, and camera analysis set to their local options. The updated Windows package includes the multilingual Whisper Small model.

Automatic clipping first reuses a saved transcript or timed subtitles in the source. If local speech recognition runs out of memory, it still offers visual clips with new captions turned off and explains why; retry transcription later when memory is available. Explicit transcription requests report the error instead of changing your chosen model.

Internet access is needed for YouTube imports, additional model downloads, external AI providers, and social publishing.

Local processing has no subscription or per-minute API charge. External providers may charge according to your account and selected model. Hosting the web version also requires server resources.

Desktop and hosted projects are separate. Connecting a provider in the desktop application does not synchronize projects with the hosted workspace.

## Editing workflow

### 1. Import

Upload an MP4, MOV, or WebM file, or inspect a public YouTube link and choose an available download quality.

Importing a source does not automatically cut it into clips.

### 2. Configure

Choose how to find moments:

- **Smart highlights:** use timed subtitles or transcribe speech, then rank
  candidate passages and keep up to the requested clip count. It can leave
  unselected parts of the recording out. With speech analysis turned off, it
  samples distinct source intervals; that structural fallback cannot judge
  what was said.
- **Full-source splitting:** divide the entire recording around the target
  duration, including its final seconds. It does not rank or drop moments;
  the clip-count limit applies only to Smart highlights.
- **Manual ranges:** choose the exact sections to keep.

Set the approximate duration, clip count, framing, and caption options before
generating. Smart highlights uses speech by default. A topic narrows its
ranking, while Full-source splitting does not rank the recording.

### 3. Review and edit

Generated clips remain editable. Give them names, adjust their start and end points, correct transcripts, move captions, and change camera or audio settings.

The clip open in the editor and the clips checked for export are separate selections. Keep or discard suggestions independently of either selection.

Projects can be archived or permanently deleted. Removing a clip from the editor has an undo action; permanent deletion is a separate confirmed action. Deleting a project also removes its uploaded source and generated files from that workspace.

### 4. Render

Save the draft, then render a preview to check the actual output.

Source playback is a quick editing view. The rendered preview applies the export pipeline, including tracking, caption styling, speed changes, and audio effects.

### 5. Export or publish

Download the current clip as an MP4 or export several selected clips as a ZIP.

Publishing is a separate, optional workflow. It requires configured platform accounts and explicit approval of the clips and destinations.

## Features

- File upload and YouTube import.
- Smart highlights, complete-source splitting, and manual ranges.
- Target duration and clip-count controls.
- Zoomable timeline and individual clip trimming.
- Numbered, editable clip names.
- Suggestion review, search, filters, duplication, reversible removal, and permanent deletion.
- Subject-following framing, manual positions, camera keyframes, fit, and blurred-background layouts.
- Local transcription and optional hosted transcription.
- Word-timed captions from local Whisper or Groq when alignment is available; corrected text remains authoritative.
- Reuse of embedded timed subtitles when available, without loading the speech model.
- Transcript correction, SRT/VTT import, and SRT download.
- Caption fonts, styles, colors, and draggable positioning.
- Playback speed, volume, mute, denoise, and audio fades.
- Rendered previews, individual exports, and batch downloads.
- Saved projects and visible background-job progress.
- A guided tour covering setup, editing, review, and export.

## Optional AI providers

Open **Settings → Processing & providers** to configure supported providers. Adding a key does not replace every local operation: select the provider for the task you want it to perform.

| Task | Local option | Optional external option |
| --- | --- | --- |
| Transcription | faster-whisper | Groq |
| Highlight ranking | Transcript and structural ranking; optional Ollama | Groq, OpenAI, Anthropic, or Gemini |
| Camera analysis | OpenCV tracking and framing rules | Gemini vision |
| Generated supporting footage | Use your own footage | Higgsfield |

Provider availability depends on your account, model access, and service limits. Ollama requires a separate installation and a downloaded model.

For source installations, the supported credential names are documented in [`.env.example`](.env.example):

```dotenv
GROQ_API_KEY=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
HF_API_KEY=
HF_API_SECRET=
```

`HF_API_KEY` and `HF_API_SECRET` refer to Higgsfield in this project.

Credentials entered in Settings are stored on the processing machine. The frontend receives configuration status rather than the saved secret values.

### Getting better results

- Set the spoken language and provide relevant vocabulary before transcription.
- Correct transcript mistakes before generating captions or ranking passages.
- Use a larger local model when the machine has enough memory and processing time.
- Use transcript-based AI ranking when you need more interpretation than structural signals provide.
- Try vision-assisted framing for complex scenes, then inspect the rendered result.
- Use manual framing or fit layouts for slides, diagrams, and footage where cropping would remove essential content.

A larger model or paid provider can improve particular tasks, but it does not guarantee accurate dialect recognition or perfect framing.
Highlight models rank locally bounded candidate ranges; they cannot invent source timestamps or render footage. Generated suggestions still need a rendered-preview review. Local framing follows faces or motion and protects broad screen content, but it does not yet identify the active speaker from lip movement and audio. The current pipeline and quality checks are described in [docs/QUALITY_PIPELINE.md](docs/QUALITY_PIPELINE.md).

### Social publishing

The publishing integration supports multiple configured accounts and explicit review before submission.

Platform credentials, account permissions, and any required platform approval must be configured separately. Some platforms also need a publicly reachable media URL, so a fully offline desktop session cannot publish directly.

Live posting is not part of the automated test evidence. These integrations should be tested with the intended accounts before relying on them for production publishing.

## Architecture

The web and desktop versions share the same frontend and processing backend.

```text
React + TypeScript editor
          |
       FastAPI
          |
  One media-job worker
          |
          +-- yt-dlp: YouTube import
          +-- faster-whisper: transcription
          +-- OpenCV: framing analysis
          +-- FFmpeg: preview and export
          |
   Project records and media
```

### Why this stack?

| Component | Reason for choosing it | Tradeoff |
| --- | --- | --- |
| React, TypeScript, Vite | An interactive editor with typed state and a straightforward frontend build | Playback state, drafts, and server state need careful coordination |
| Python and FastAPI | One backend close to the media and machine-learning libraries | CPU-heavy work must run outside the request handler |
| FFmpeg and FFprobe | Media inspection, conversion, filtering, and encoding | Rendering requires CPU time and temporary disk space |
| OpenCV | Local framing analysis without a paid service | Tracking is heuristic and can misinterpret graphics or complex scenes |
| faster-whisper | Local multilingual speech recognition | Larger models consume more memory and take longer |
| JSON records and local media files | A small deployment that works offline without a database service | Limited concurrency and no tenant isolation |
| One processing worker | Predictable resource usage on a laptop or small VM | Jobs wait when another job is running |
| pywebview and PyInstaller | Package the existing application with its Python processing tools | Windows runtime and native dependencies need packaging checks |

The frontend saves editing instructions rather than rewriting the source video after every adjustment. Render jobs use a snapshot of those instructions. Exports have their own output paths, so an older render does not overwrite a newer draft.

Metadata writes use temporary files and replacement. This reduces the chance of partial writes; it does not replace backups of source videos and project storage.

More detail is available in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Hosted deployment

```text
Browser
   |
Vercel — built frontend and API/media rewrites
   |
Caddy — HTTPS reverse proxy on Azure
   |
FastAPI + media worker
   |
Persistent project, media, export, and model storage

FastAPI → Supabase Auth for owner sign-in
```

Vercel serves the frontend. Azure runs the persistent processing service because transcription and video encoding need sustained compute and disk access.

Supabase handles authentication. It is not currently the video worker, project database, or media store.

Hosted access is restricted to one configured Supabase user ID. Sessions are held in worker memory, so restarting the worker requires signing in again.

See [docs/HOSTING.md](docs/HOSTING.md) for deployment configuration.

## Run from source

Install:

- Python 3.11 or newer
- Node.js 20 or newer
- FFmpeg and FFprobe, available on `PATH`

From the repository root:

```powershell
python launch.py
```

The launcher prepares the environment, installs dependencies, builds the frontend, and opens:

```text
http://127.0.0.1:8767
```

Keep the terminal open while using the application.

To rebuild dependencies and frontend assets:

```powershell
python launch.py --rebuild
```

On macOS or Linux, use `python3 launch.py`. Docker users can run:

```bash
docker compose up --build
```

A source installation downloads the selected speech model on first use. Subsequent local runs can use the cached model offline.

## Tests and Windows builds

Run the source checks from PowerShell:

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

The current source tree passes **202 Python tests**, frontend tests, and a production frontend build. Real-media tests exercise import, editing, rendering, captions, MP4 export, ZIP export, and persistence.

These results do not establish that every provider, social account, or hosted workflow has been tested live. The new source changes have not been packaged into the published Windows ZIP or deployed to the hosted worker. The evidence and remaining checks are recorded in [docs/VALIDATION.md](docs/VALIDATION.md).

To build the Windows package from a prepared build environment:

```powershell
pwsh desktop/build.ps1
```

The output is:

```text
build/desktop/Clipflow-windows-x64.zip
```

The build checks the bundled frontend, media tools, speech model, and runtime support files before creating the archive. See [docs/DESKTOP.md](docs/DESKTOP.md) and the [release checklist](docs/RELEASE-CHECKLIST.md).

## Development stages

The application grew through five stages:

1. **Core processing:** upload or import a recording, create clips, reframe, and export with free local tools.
2. **Editing workflow:** separate source setup from generation, add individual clip edits, timeline controls, captions, and rendered previews.
3. **Review and integrations:** add suggestion decisions, batch selection, provider settings, and approval-based publishing.
4. **Desktop and hosting:** package the local runtime and deploy the shared frontend/backend architecture behind owner authentication.
5. **Reliability and handoff:** improve import failures, package verification, onboarding, regression coverage, and setup documentation.

The current repository contains the source improvements. A hosted worker must be rebuilt from the corresponding revision to receive backend changes; pushing frontend code alone does not update that worker.

## Current limits and next steps

This release suits a local user or a single hosted owner workspace. It is not yet a multi-tenant service.

The next useful improvements would be:

- **Persistent job queue:** separate API requests from processing workers and add controlled retries, scheduling, and GPU workers.
- **Database and object storage:** move metadata to Postgres and media to private object storage, with resumable uploads and tenant-specific access.
- **Stronger camera planning:** combine scene boundaries, speaker detection, tracked objects, and protected text regions to reduce unnecessary movement and avoid cutting out important content.
- **Better speech evaluation:** benchmark real multilingual and Algerian Arabic samples, improve vocabulary handling, and measure quality before changing defaults.
- **Deeper highlight selection:** combine transcript meaning with visual context, remove repetitive suggestions, and evaluate whether clips remain understandable on their own.
- **Collaboration:** separate reviewer and publisher roles, add approval history, and support shared projects safely.
- **Distribution and operations:** signed desktop releases, update support, monitored workers, storage quotas, and tested backup recovery.

The existing separation between the editor, processing tasks, provider adapters, and exported artifacts provides a starting point for those changes. Scaling to multiple users still requires changes to storage, authentication, and job coordination.
