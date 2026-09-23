# Validation record

Evidence current through 2026-09-23. This records what was exercised, not a guarantee that every external service will remain available.

## Source and build checks

- The full Python suite passed: **237 tests**. Frontend tests and the production build passed.
- [Source CI](https://github.com/aminemons/clipflow/actions/runs/35906942615) passed on revision `267e9d3`.
- A public YouTube video downloaded successfully through the desktop import code on a local Windows connection. The resulting MP4 was 533,932 bytes.
- The desktop-import tests cover URL and quality validation, ticket expiry and replay, bearer authentication, upload limits, and project creation. Live paid-provider calls were not part of these checks.

## Hosted import

- The [hosted editor](https://clipflow-aminemons.vercel.app) and Azure worker include revision `267e9d3`. After deployment the worker health check passed.
- Azure still received a YouTube bot challenge for public video `jNQXAC9IVRw` through both the ordinary and browser-style yt-dlp requests. The site presents **Import with desktop** for this case rather than treating the blocked request as a successful import.
- A live authenticated handoff test signed in, created a one-use ticket, downloaded that video on the local PC, uploaded it to the Azure worker, and confirmed the hosted project reached `source_ready`. The test project was then deleted. The PC's DNS resolver was intermittently failing, so this test used a temporary per-process DNS mapping for the app hostnames; no system DNS setting was changed.
- An earlier hosted smoke test covered upload, automatic clip generation, proof, and export. It confirmed the export download link appeared, but did not play the resulting hosted MP4.
- The public [Cobalt API](https://github.com/imputnet/cobalt/blob/main/docs/api.md) is not a supported backend: its operators do not permit other projects to use their hosted instance without permission. Hosting it on the same Azure VM would retain the blocked egress IP.

## Windows release

- [Windows release workflow 35907285265](https://github.com/aminemons/clipflow/actions/runs/35907285265) passed on revision `267e9d3`. It extracted the ZIP into a fresh directory, launched the packaged application, verified `clipflow://` registration, generated a Smart clip with bundled offline speech models, and exported a 720×1280 H.264 MP4.
- The [release ZIP](https://github.com/aminemons/clipflow/releases/tag/desktop-267e9d3a6e173881bc2a34a1a22602a4992b2541) is 852,976,162 bytes; SHA-256: `4eb6c0ef0aa369b3ccf031debbcab4ddf9a817a669795708014f59012b699817`.
- The hosted **Download desktop** endpoint reports the same ZIP size and served a ranged request with HTTP 206 and ZIP header bytes.
- The packaged GUI was not opened manually on this PC because it lacked space for both the archive and a fresh extraction. The CI extraction and application-level checks passed, but do not replace a human GUI check on a second PC.

## Operational limits

- YouTube can also challenge a home connection. The desktop handoff is a tested alternate route, not a guarantee against future upstream changes. Uploading a video file remains available.
- Hosted mode is single-owner and single-worker. Worker restarts interrupt active jobs and require a new sign-in; storage and recovery need monitoring.
- Local transcription depends on available memory and the selected model. Visual tracking and free highlight ranking remain heuristic; they do not guarantee a viral result.
- Publishing integrations and paid AI providers were not exercised against live accounts in these checks. The assessment credentials in the README were published at the owner's request and should not be used for private material.
