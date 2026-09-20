# Clipflow

Clipflow is a local-first video editor for turning a long 16:9 video into editable 9:16 clips. Import a video file or a YouTube URL, let the editor suggest ranges, adjust clip boundaries, generate captions, inspect the rendered proof, and export one MP4 or a ZIP of selected clips. The workspace stores project data and media on the machine running the app.

The core path uses FFmpeg/FFprobe, OpenCV, and yt-dlp. Segmentation combines scene changes and silence when those signals are available. Reframing follows a detected focus point with smoothing and falls back safely when detection is unavailable. The result is a practical local baseline, not a claim of semantic “viral moment” detection.

## Workspace

Importing a source never starts clipping. For YouTube, choose **Check video**, review its details, choose a download quality, then import. **Clip setup** guides you through moments (suggested, full source, or manual ranges), camera framing, captions and audio. The final **Generate clips** button runs one job that applies those choices to every new clip. Existing clips and exports are preserved. Open **Edit clips**, select a result, and adjust its timing, camera path, captions or audio independently. Camera paths are evaluated during proof/export rendering; render a proof to check the actual result.

Under **Settings > Publishing**, add named YouTube, Instagram and TikTok accounts. Approve rendered exports, select individual destination accounts, then review the account list, privacy and captions before confirming a post. Configuring accounts does not publish anything. Providers require their OAuth credentials and platform-specific access; Instagram/TikTok also need a publicly reachable media URL.

- **Projects** opens the media library. Start a new project from a file or YouTube link, search names or tags, favorite frequently used sources, switch between grid and list, and rename or archive projects. Archive is reversible and keeps every source, edit, and export.
- **Editor** separates Clipping, Layout, Captions, and Audio controls. The clip being edited is independent of the export checkboxes. Zoom the timeline, adjust boundaries, expand playback, review candidates, and export one clip or a selection.
- **Exports** keeps finished versions and job activity together, with project filters, playable MP4 previews, downloads, cancellation, errors, and retry controls.
- **Publish** lets you approve one or all rendered clips, choose destinations and post text, then confirm the exact files before sending. Editing or re-exporting invalidates approval. YouTube, Instagram and TikTok require their platform credentials and permissions; see [publishing setup](docs/PUBLISHING.md).
- **Settings** contains optional provider keys, processing preferences, storage usage, preview cleanup, and help. A first-visit walkthrough highlights the actual controls; replay the whole tour here or from the sidebar.

Layouts support 9:16, 1:1, 4:5, and 16:9 output with subject following, manual focus, fit, or a blurred background. The resolution selector reports the final dimensions. Source playback approximates framing; **Render proof** runs the same rendering pipeline used by export.

Caption styles include reusable presets and custom styles saved in this browser. Apply a style to one clip or all clips, drag caption position, or enter X/Y coordinates. Import SRT/WebVTT files with **source-video timestamps** to replace the source transcript after confirmation; existing clip-specific corrections and manual overlays are retained. Subtitle import does not run speech recognition or require a key.

Reference research and implementation choices are recorded in [docs/NEW-REFERENCES.md](docs/NEW-REFERENCES.md) and [docs/WORKSPACE-REBUILD.md](docs/WORKSPACE-REBUILD.md). Reference code and their branding were not copied.

Smart camera controls in **Editor → Layout** provide steady, smooth and dynamic movement, a tracking dead zone, zoom, and source-time keyframes for camera position. The renderer uses face detection, motion fallback and bounded movement. Review the rendered proof before exporting; source playback does not simulate the tracking path. See [camera behavior](docs/SMART-CAMERA.md).

Optional OpenAI, Claude, Gemini, Groq and local Ollama models rank transcript highlight candidates. Local ranking requires no service. Configure editable model IDs and keys under **Settings → Processing & providers**; hosted choices send candidate transcript text to the selected provider and may incur provider charges. They do not change the local video rendering pipeline. Whisper remains the offline speech option; models download once and can then run without network access.

The sidebar's **Download desktop** serves the Windows portable ZIP when a build is present. Extract it and run `Clipflow.exe`. Desktop build and offline requirements are in [docs/DESKTOP.md](docs/DESKTOP.md). Web deployment remains optional; this workspace runs locally.

## Quick start on Windows

Install these prerequisites first:

- Python 3.11 or newer
- Node.js 20 or 22, including npm
- FFmpeg with both `ffmpeg.exe` and `ffprobe.exe` on `PATH`

From the repository folder, double-click `start.cmd`. It runs `python launch.py`, creates the local `.venv` on first run, installs the backend requirements, builds the frontend, starts the API, and opens the browser. Keep the console window open while using Clipflow; press `Ctrl+C` to stop it.

The equivalent command is:

```powershell
python launch.py
```

Useful launcher options:

```powershell
python launch.py --no-browser
python launch.py --port 8767
python launch.py --rebuild
```

The first run needs internet access for Python and npm packages. Later runs reuse `.venv` and the built frontend. If startup reports a missing executable, verify `python --version`, `node --version`, `npm --version`, `ffmpeg -version`, and `ffprobe -version` in a new terminal.

## Optional provider setup

The editor needs no provider key for its free workflow. Open the gear button, choose your transcription and highlight providers, paste optional keys, and save. Settings take effect for the next job without restarting. Keys are stored only in the server's `.env`; the browser receives configured/not-configured flags. Blank key fields keep existing values, and Remove clears a saved key. Settings cannot change while a job is running.

You can also edit `.env` beside `launch.py` and restart. The launcher creates it from `.env.example` on first use.

- Local captions: leave `CLIPFLOW_TRANSCRIPTION_PROVIDER=local`. Choose Quick draft (tiny), Balanced (small), or Thorough (large-v3) in the Transcription controls. Missing models need sufficient cache space; recognition also needs available RAM and virtual memory. Clipflow reports resource failures without silently switching models.
- Groq captions: set `CLIPFLOW_TRANSCRIPTION_PROVIDER=groq` and add `GROQ_API_KEY`.
- Groq highlight selection: set `CLIPFLOW_HIGHLIGHT_PROVIDER=groq`; it uses the same `GROQ_API_KEY` and configurable `GROQ_HIGHLIGHT_MODEL`.
- Higgsfield B-roll: add `HF_API_KEY` and `HF_API_SECRET`.

For speech options, use Auto, Arabic, French, or English, and select Algerian Darija when the recording uses that dialect. Darija selects Arabic recognition and adds a context hint; it does not translate speech and does not guarantee dialect-level accuracy. You can provide a domain prompt of up to 500 characters. Set `CLIPFLOW_MODEL_CACHE` or `HF_HOME` to a persistent drive with room for the selected model. Fast local transcription remains the small-disk path.

Keys stay server-side and are never needed in the browser. Provider requests can incur the account owner’s limits or credits; import, editing, tracking, manual captions, render proof, and export remain available without them.

## Smart highlights and direct editing

Choose **Full video** to segment the entire source, or **Smart highlights** to select a smaller set. Set an approximate duration, allowed variation, optional strict maximum, maximum count, and topic. For example, 30 seconds with 30% variation permits 21–39-second suggestions unless the strict maximum is lower. A short source remains usable as a shorter clip. Review each suggestion's reason, keep or discard it, and restore discarded suggestions from the library. Regeneration preserves existing edits and decisions.

Free local highlights rank transcript passages using topic matches, speech coverage, and distinct wording. Speech analysis can automatically run local Whisper first. With speech analysis off, the selector samples structural scene/silence boundaries across the source; it does not understand pictured actions or emotions. Groq adds language-model selection among bounded transcript candidates. It sends transcript text to Groq; choosing Groq for transcription separately sends audio. Clip-scoped transcripts retain their source timestamps and are reused when the same source range and settings are requested.

Only the suggested highlights are selected for export. The clip being edited can differ from the clips selected for export. Earlier clips and edits remain available; the source is never cut or deleted. Selection reasons explain what the free ranker observed, rather than predicting virality. Re-running identical ranges reuses clips.

Drag captions or enter their X/Y percentage position. The same normalized position is used in rendered proofs and exports. Use the caption toggle to export without burned captions, or bottom/center placement presets. Expand the preview without resetting playback; Escape closes it. Playback controls remain below the image. Edit mode exposes the inspector; Review gives the library more room. Working on one clip leaves the export checkboxes unchanged.

## Docker alternative

With Docker Desktop running:

```powershell
docker compose up --build
```

Open <http://127.0.0.1:8767>. The compose file binds the app to localhost and keeps application data in the named `clipflow-data` volume. Stop it with `Ctrl+C`; use `docker compose down` to remove the running stack. Keep the named volume if you want to retain projects and rendered files.

## Demo flow

1. Open Clipflow and choose a local video, or paste a YouTube URL.
2. Wait for analysis to finish and review the suggested clips.
3. Select a clip, adjust its numeric start/end values, rename or duplicate it, and remove any unwanted range.
4. Use the source preview and timeline to check the original footage. Generate captions with Transcription or enter a manual caption overlay; choose its style, color, and position.
5. Select Render proof to inspect the actual tracked crop and burned captions inline. Export one selected clip as MP4, or select several clips for a ZIP. Each export job receives immutable download artifacts, so a later export does not replace an earlier result. The Exports panel also provides job progress, cancellation, and retry.

Local transcription uses the installed `faster-whisper` package and caches the selected model on first use. Balanced is the new-user default; Fast uses tiny, while Accurate uses large-v3. The first caption job may download model files and can be CPU-intensive. For hosted transcription, select Groq and add `GROQ_API_KEY` in Settings. Changes apply immediately. Manual `.env` edits require a restart.

## Transcript, sound, and pace

- Open **Transcript** in the output sidebar after transcription. Search for speech, use a timestamp to seek, correct text, and save. Corrections change subtitles without changing the recording.
- Select a first and last transcript passage, then **Create clip from passage**. The new clip includes the entire interval between them and can be trimmed normally. Unsaved corrections are saved before creating it.
- Open **Sound & pace** for the selected clip. Set speed from 0.5× to 2×, adjust volume from mute to 200%, enable basic background-noise reduction, and add audio fades of up to two seconds at both ends.
- Render a proof to hear the processed audio. Playback speed changes video, audio, burned captions, and downloaded SRT together. Source timestamps and trim handles continue to refer to the original video.
- These tools run locally without API keys. Noise reduction uses FFmpeg's spectral filter; it cannot reliably isolate speech from every background sound.

## Architecture

The CI configuration is included as [`docs/github-actions.example.yml`](docs/github-actions.example.yml). To enable it, copy it to `.github/workflows/ci.yml` using a GitHub login with workflow permissions. The current publication credential could push source but could not create workflows. Local validation results are recorded in [`docs/VALIDATION.md`](docs/VALIDATION.md).

The Python service owns ingestion, project persistence, analysis, tracking, rendering, ZIP creation, and job progress. The React/Vite frontend is built into `frontend/dist` and served by the local API. Long operations run in a small in-process thread pool and the browser polls `/api/jobs/{job_id}`.

The main API contract includes health and capability status, file/YouTube/demo ingestion, project reads, clip add/update/delete, analysis, local or Groq transcription, preview/render proof, export, MP4 download, ZIP download, SRT download, and optional Higgsfield B-roll generation. Import, editing, tracking, captions, preview, and export remain usable without paid keys.

Higgsfield B-roll is optional. Enable it and add `HF_API_KEY` and `HF_API_SECRET` in Settings; generation uses your Higgsfield account credits. The local editor does not require those keys.

## Known limits

- Subject framing supports automatic face continuity or a left/right face preference, with a brightness-based saliency fallback when no face is found. It is not active-speaker or identity recognition; crossings, small faces, occlusion and fast cuts can still need manual framing correction.
- The Haar face detector can mistake graphics for faces; this occurred in a real-media check. Use manual focus and a render proof for graphic-heavy material. Multiple-person tracking has not passed a representative accuracy benchmark.
- The browser preview is an approximate editing view. Inspect the rendered MP4 to verify the final crop and encoding.
- YouTube ingestion depends on yt-dlp and the source platform. Upstream changes, private videos, age gates, region restrictions, or network failures can stop import.
- Jobs use an in-process thread worker. Stopping or restarting the app interrupts active work; retry the operation after restart.
- Large videos need local disk space and CPU time. H.264 rendering is intentionally conservative for portability.
- Local Whisper uses the selected cached model; first use may download model files and can be slow on CPU. A missing large model is reported as a storage/setup error rather than silently using tiny. Groq is an optional hosted alternative and sends audio to the provider.
- User media and project data stay in the local workspace/container volume with local providers selected. Hosted transcription sends audio to Groq; hosted highlights sends transcript candidates and the requested topic. Higgsfield receives the generation prompt.

## Reproducible checks

From `outputs/clipflow`:

```powershell
python -m compileall backend launch.py
python -m pip install -r backend/requirements.txt
Push-Location frontend
npm ci
npm run build
Pop-Location
```

For a running localhost app, verify `GET /api/health`, inspect capability status, create the built-in demo project, adjust a clip, generate the render proof, and export it. Install `pytest` and run `python -m pytest backend/tests tests -q` for the automated checks. Results and the live browser checks are recorded in [`docs/VALIDATION.md`](docs/VALIDATION.md). Paid providers were checked with mocks, without spending credits.

## License and attribution

Clipflow is distributed under the repository `LICENSE`. Third-party dependency and license notes are in [`docs/DEPENDENCIES.md`](docs/DEPENDENCIES.md). The competitor/product research is in [`docs/PRODUCT-RESEARCH.md`](docs/PRODUCT-RESEARCH.md); provider feature claims and prices can change.

## Rebuild and hosted deployment

Read the [architecture decisions](docs/ARCHITECTURE.md), [source repository comparison](docs/REFERENCE-RESEARCH.md), [requirements checklist](docs/REBUILD-CHECKLIST.md), and [hosted setup](docs/HOSTING.md). Vercel serves the frontend; a persistent container runs the API and media jobs. Optional Supabase authentication protects one private owner workspace. A Vercel frontend alone is not a working hosted video processor, and no backend URL defaults to a developer's localhost.

Project metadata migrates additively. The first legacy save retains a `.json.v1.bak`; later saves retain one `.json.bak`. Back up the entire `CLIPFLOW_DATA` directory, including source videos, before moving machines. Provider settings contain secrets and should be copied privately, never committed or shared in a source archive.
