# Validation record

Evidence current through 2026-09-23. This records what was exercised, not a guarantee that every external service will remain available.

## Source and build checks

- The full Python suite passed **252 tests** in [release CI](https://github.com/aminemons/clipflow/actions/runs/35917728287). Frontend tests and the production build passed.
- A public YouTube video downloaded successfully through the desktop import code on a local Windows connection. The resulting MP4 was 533,932 bytes.
- The desktop-import tests cover URL and quality validation, ticket expiry and replay, bearer authentication, upload limits, and project creation. Live paid-provider calls were not part of these checks.

## Hosted import

- The [hosted editor](https://clipflow-aminemons.vercel.app) and Azure worker include revision `267e9d3`. After deployment the worker health check passed.
- Azure still received a YouTube bot challenge for public video `jNQXAC9IVRw` through both the ordinary and browser-style yt-dlp requests. The site presents **Import with desktop** for this case rather than treating the blocked request as a successful import.
- A live authenticated handoff test signed in, created a one-use ticket, downloaded that video on the local PC, uploaded it to the Azure worker, and confirmed the hosted project reached `source_ready`. The test project was then deleted. The PC's DNS resolver was intermittently failing, so this test used a temporary per-process DNS mapping for the app hostnames; no system DNS setting was changed.
- An earlier hosted smoke test covered upload, automatic clip generation, proof, and export. It confirmed the export download link appeared, but did not play the resulting hosted MP4.
- The public [Cobalt API](https://github.com/imputnet/cobalt/blob/main/docs/api.md) is not a supported backend: its operators do not permit other projects to use their hosted instance without permission. Hosting it on the same Azure VM would retain the blocked egress IP.

## Windows release

- [Windows release workflow 35917728287](https://github.com/aminemons/clipflow/actions/runs/35917728287) passed on revision `34757cc`. It extracted the ZIP into a fresh directory, launched the packaged application, verified `clipflow://` registration, generated a Smart clip with bundled offline speech models, and exported a 720×1280 H.264 MP4; the Python suite passed 252 tests.
- The current [Windows release](https://github.com/aminemons/clipflow/releases/tag/desktop-34757cc7baff06ef1934ee37e8f1709835b1b4a5) ZIP is 852,998,084 bytes; SHA-256: `511fa94260f5dd42a0ee562126e36ab5f4cb96c0e8449c83c9a57fc5608a811a`.
- The hosted **Download desktop** endpoint reports the same ZIP size and served a ranged request with HTTP 206 and ZIP header bytes.
- The packaged GUI was not opened manually on this PC because it lacked space for both the archive and a fresh extraction. The CI extraction and application-level checks passed, but do not replace a human GUI check on a second PC.

## Operational limits

- YouTube can also challenge a home connection. The desktop handoff is a tested alternate route, not a guarantee against future upstream changes. Uploading a video file remains available.
- Hosted mode is single-owner and single-worker. Worker restarts interrupt active jobs and require a new sign-in; storage and recovery need monitoring.
- Local transcription depends on available memory and the selected model. Visual tracking and free highlight ranking remain heuristic; they do not guarantee a viral result.
- Publishing integrations and paid AI providers were not exercised against live accounts in these checks.

## Adobe edit handoff

- Automated tests in `backend/tests/test_nle_export.py` check the ZIP contents, Premiere XML structure and media references, SRT and JSX content, playback-speed metadata, and the API download response. They do not open Adobe applications.
- To exercise the handoff manually, create or open a project, save its edits, and download an Adobe edit package for one clip or selected clips. Extract the whole ZIP. In Premiere Pro, import `Premiere.xml`; if media is offline, relink to the extracted `media` folder. Check source trims and audio/video placement, then reapply playback speed from `manifest.json`. Import `captions.srt` at the start of the sequence and inspect cue timing after speed changes. In After Effects, run `after-effects.jsx` with **File → Scripts → Run Script File**, confirm the `.aep` is saved beside the script, then reopen it with the extracted media folder still alongside. If saving is blocked, enable **Preferences → Scripting & Expressions → Allow Scripts to Write Files and Access Network** and rerun the script.
- No manual Premiere Pro or After Effects import/script run has been completed in the validation environment. The handoff is a starting point: crop/reframe, camera tracking, denoise, caption appearance, and other Clipflow render effects are not reconstructed. For mixed aspect ratios, the first selected clip sets the Premiere sequence canvas.
