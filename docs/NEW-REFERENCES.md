# Reference study: OpenShorts and OpenSource Clipping

Research snapshot: 2026-09-20. Repositories were inspected from their public source at these default-branch commits:

- [mutonby/openshorts](https://github.com/mutonby/openshorts), `27d4916ca74d29c3e2f86545a29dc2119e53c506`.
- [NaufalRizqullah/opensource-clipping](https://github.com/NaufalRizqullah/opensource-clipping), `3c72b75c684b9f5bc2469af7c983eb279fd14160`.

No repository code was copied into Clipflow and no downloaded code was executed. Small text/source snapshots and selected OpenShorts screenshots live under `work/reference-refresh/` for review.

## What to borrow from OpenShorts

OpenShorts is the stronger product and interaction reference for Clipflow. Its app shell is a dark, dense workbench: a desktop rail is 80px icon-only at medium widths and 256px labelled at large widths; the selected item has a muted surface plus a thin brass left rule. On phones the rail disappears, a five-up bottom tab bar carries everyday destinations, and a “more” drawer exposes the rest. The nav source is [dashboard/src/App.jsx](https://github.com/mutonby/openshorts/blob/main/dashboard/src/App.jsx) (`navItems`, `Sidebar`, `MobileNavDrawer`, `MobileTabBar`).

The real destinations are `Clip Generator`, `AI Shorts`, `AI Agent`, `UGC Gallery`, `YouTube Studio`, conditional `History`, and `Settings`. The first-run path locks the other tabs until the clip tutorial is completed; the tutorial state and recovery behavior are implemented in `App.jsx`, not a mock route. The idle Clip Generator is deliberately focused: “Create Viral Shorts”, a short explainer, an upload/link card, format choice, and one primary action. The source is [MediaInput.jsx](https://github.com/mutonby/openshorts/blob/main/dashboard/src/components/MediaInput.jsx).

The input workflow has two tabs (`Upload File` and `Video URL`), drag/drop and file selection, a supported-platform popover, a rights attestation, and format cards for `9:16`, `1:1`, and `16:9`. Advanced controls are collapsed until needed: target clip count, min/max length, layout (`auto`, `split`, `screencast`, `none`), automatic hook text and hook style. This is a good Clipflow pattern: make the first action obvious and keep model/render controls discoverable without making the landing state look like a form.

The strongest editor reference is [ClipEditor.jsx](https://github.com/mutonby/openshorts/blob/main/dashboard/src/components/ClipEditor.jsx). It opens as a full-height workbench and becomes three columns above `xl`:

1. `Source`: source video monitor, source scrubber, mark-in/mark-out controls, and a word-level transcript. Clicking a word can set a segment boundary; the selected range can replace or insert a segment.
2. `Program`: vertical output preview plus the assembled clip timeline. Rendered and unrendered spans are visually distinguished so users understand why a changed edit needs a render.
3. `Segments`: cards with start/end inputs, duration, select, move up/down, split, delete, undo/redo, framing (`auto`, `full frame`, `track subject`), word snapping, and “re-apply captions after recut”.

The editor’s useful product behavior is as important as its layout: edits are an EDL, undo/redo is reducer-backed, word snapping is optional, and a re-render is required only for changed source ranges or framing. The backend endpoints that make this real are `GET /api/clip/{job}/{index}/edl`, `GET .../transcript`, `POST /api/clip/rerender`, `POST /api/clip/reframe`, and `GET .../scenes` in [app.py](https://github.com/mutonby/openshorts/blob/main/app.py). Clipflow should preserve this “edit recipe first, render derived media second” model.

The visual language is distinctive and reusable without copying assets. [tokens.css](https://github.com/mutonby/openshorts/blob/main/dashboard/src/tokens.css) defines a “night foundry” palette: paper surfaces at roughly 13%, 16.5%, and 20% lightness; near-white ink; very low-opacity rules; and a warm brass accent. Typography is Instrument Serif for display headings, Geist for body, and JetBrains Mono for tiny uppercase labels/readouts. Cards use 10px radii, controls 8px, and motion is restrained (`fade`, edge drawer, sheet-up). [index.css](https://github.com/mutonby/openshorts/blob/main/dashboard/src/index.css) shows the reusable card, eyebrow, readout, badge, button, input, and mobile-control rules.

For visual comparison, these are the repository’s actual assets:

- [Clip results screenshot](https://raw.githubusercontent.com/mutonby/openshorts/main/screenshots/clip-results.png)
- [AI Shorts screenshot](https://raw.githubusercontent.com/mutonby/openshorts/main/screenshots/ai-shorts.png)
- [YouTube Studio screenshot](https://raw.githubusercontent.com/mutonby/openshorts/main/screenshots/youtube-studio.png)
- [UGC gallery screenshot](https://raw.githubusercontent.com/mutonby/openshorts/main/screenshots/ugc-gallery.png)
- [Split layout before/after GIF](https://raw.githubusercontent.com/mutonby/openshorts/main/screenshots/split-before-after.gif)

## What to borrow from OpenSource Clipping

OpenSource Clipping is a simpler, useful reference for job lifecycle and optional render controls. Its React dashboard has three routes in [web/dashboard/src/App.jsx](https://github.com/NaufalRizqullah/opensource-clipping/blob/main/web/dashboard/src/App.jsx): `Dashboard`, `New Job`, and `Settings`; a `/job/:jobId` detail route handles progress and outputs. The older static GitHub Pages studio has the same information architecture in [docs/studio/index.html](https://github.com/NaufalRizqullah/opensource-clipping/blob/main/docs/studio/index.html), [new-job.html](https://github.com/NaufalRizqullah/opensource-clipping/blob/main/docs/studio/new-job.html), [job.html](https://github.com/NaufalRizqullah/opensource-clipping/blob/main/docs/studio/job.html), and [settings.html](https://github.com/NaufalRizqullah/opensource-clipping/blob/main/docs/studio/settings.html).

The dashboard shows total jobs, completed jobs, total clips, running jobs, and a job list whose cards include source, date, clip count, progress text, and status. `New Job` supports URL, upload, and reuse of an earlier job; URL source choices include YouTube, TikTok, Instagram, and Google Drive. Its controls include clip count (1–30), aspect ratios `9:16`, `16:9`, `1:1`, `3:4`, and `4:5`, font style, AI provider, Whisper model/device, and toggles for B-roll, hook glitch, BGM, karaoke, Hook V2, silence trim, YouTube subtitle reuse, no subtitles, and reuse of saved Gemini JSON. This is implemented in [NewJob.jsx](https://github.com/NaufalRizqullah/opensource-clipping/blob/main/web/dashboard/src/pages/NewJob.jsx).

The job detail screen has a concrete progress model: `Download → Transcribe → AI Analysis → Metadata → Render → Done`, a percentage bar, progress message, generated vertical videos, viral score/duration/rank metadata, downloads, and a log viewer. It receives server-sent events and also polls every five seconds, which is a robust recovery pattern for local jobs. See [JobDetail.jsx](https://github.com/NaufalRizqullah/opensource-clipping/blob/main/web/dashboard/src/pages/JobDetail.jsx) and [jobs.py](https://github.com/NaufalRizqullah/opensource-clipping/blob/main/web/api/routes/jobs.py).

Its visual system is a conventional dark slate dashboard: fixed 260px sidebar, `#0a0a0f` background, violet `#8b5cf6` accent, Inter body, JetBrains Mono logs, 6/10/14/20px radii, translucent borders, and modest lift/glow hover states. The exact tokens are in [index.css](https://github.com/NaufalRizqullah/opensource-clipping/blob/main/web/dashboard/src/index.css). Clipflow should use OpenShorts’s warmer night-foundry shell and borrow OpenSource Clipping’s explicit job steps, status vocabulary, and log fallback.

## Backend reality and provider boundaries

OpenShorts’s core clip path is real code, not a front-end stub: FastAPI accepts uploads or URLs, queues jobs, persists/reconstructs manifests, transcribes, selects moments, renders with FFmpeg, archives artifacts, and exposes status, source, download, edit, reframe, subtitle, hook, translation, social, thumbnail, and AI Shorts endpoints. Endpoint inventory is visible in [app.py](https://github.com/mutonby/openshorts/blob/main/app.py). The core path uses `yt-dlp`, faster-whisper or NVIDIA Parakeet, Gemini or an OpenAI-compatible text LLM, MediaPipe/YOLO tracking, FFmpeg, and optional S3/R2 archival.

Provider limits matter:

- `LLM_BASE_URL` can move transcript-based moment picking to Ollama, LM Studio, vLLM, or another OpenAI-compatible server. Silent-video vision and some layout decisions still need Gemini; see [llm_backend.py](https://github.com/mutonby/openshorts/blob/main/llm_backend.py) and the README’s local-LLM section.
- OpenShorts AI Shorts uses fal.ai for actors/video/lip-sync, ElevenLabs for dubbing/voice, and Upload-Post for publishing. These are real integrations but paid or account-gated, so they are not a sensible Clipflow core dependency. They are isolated advanced features in the dashboard ([SaaShortsTab.jsx](https://github.com/mutonby/openshorts/blob/main/dashboard/src/components/SaaShortsTab.jsx), [translate.py](https://github.com/mutonby/openshorts/blob/main/translate.py), and social endpoints in `app.py`).
- OpenSource Clipping’s core path is also real: FastAPI queues a background worker, downloads with `yt-dlp` or accepts an upload, reuses YouTube JSON3 subtitles when available, falls back to faster-whisper, calls Gemini or NVIDIA NIM, renders via FFmpeg, and streams progress over SSE. See [worker.py](https://github.com/NaufalRizqullah/opensource-clipping/blob/main/web/api/worker.py), [engine.py](https://github.com/NaufalRizqullah/opensource-clipping/blob/main/clipping/engine.py), and [core.py](https://github.com/NaufalRizqullah/opensource-clipping/blob/main/clipping/studio/core.py).
- OpenSource Clipping’s optional features are concrete modules rather than placeholders: MediaPipe BlazeFace or YOLO tracking ([face_detection.py](https://github.com/NaufalRizqullah/opensource-clipping/blob/main/clipping/studio/face_detection.py)), ASS karaoke subtitles ([subtitles.py](https://github.com/NaufalRizqullah/opensource-clipping/blob/main/clipping/studio/subtitles.py)), local mood-based BGM with sidechain ducking ([audio_bgm.py](https://github.com/NaufalRizqullah/opensource-clipping/blob/main/clipping/studio/audio_bgm.py)), Pexels B-roll ([broll.py](https://github.com/NaufalRizqullah/opensource-clipping/blob/main/clipping/studio/broll.py)), and frame/title thumbnails ([thumbnail.py](https://github.com/NaufalRizqullah/opensource-clipping/blob/main/clipping/studio/thumbnail.py)).
- Podcast split-screen and camera switch use Pyannote diarization when `HF_TOKEN` is configured; a face-trigger mode avoids that token. The implementation and tradeoffs are documented in [Podcast Modes](https://github.com/NaufalRizqullah/opensource-clipping/blob/main/wiki/5-Podcast-Modes.md). This is a later feature for Clipflow because it adds heavyweight model/runtime requirements.

Neither repository’s dashboard should be treated as a complete hosted multi-tenant backend. OpenShorts’s hosted billing/social/gallery surfaces depend on its cloud service; the self-hosted core works without them. OpenSource Clipping’s browser studio is designed to connect to a Kaggle/Colab or local FastAPI process through a tunnel; settings and jobs are process-local and there is no user account model in the dashboard.

## Ranked Clipflow adoption

1. **Ship now: project/job shell plus editor recipe.** Keep Clipflow’s project-centric navigation and library, add OpenShorts’s source/program/segments editor structure, EDL persistence, word-level transcript boundary actions, undo/redo, and render coverage indicators. This is the highest-value workflow match and uses the existing local backend shape.
2. **Ship now: output presets and caption controls.** Keep the current format choices and add the proven OpenSource Clipping ratios (`3:4`, `4:5`) where useful. Use Clipflow’s caption presets/SRT import, with karaoke timing as an optional render style; OpenSource Clipping’s ASS generator is the implementation reference, not an asset to copy.
3. **Ship now: robust job progress.** Adopt the explicit six-step progress model, real log tail, terminal error state, retry/clone behavior, and SSE-or-poll fallback. This makes local processing understandable even when a render takes minutes.
4. **Next: framing choices.** Offer `auto`, `full frame`, `track subject`, and a safe blurred-fit mode. OpenShorts’s per-scene TRACK/GENERAL/SPLIT/SCREENCAST choices are technically real but should be staged behind a simple Clipflow control.
5. **Next: free local production polish.** Add optional hook overlay, local BGM mood folders with ducking, and thumbnail frame/title generation. Require the user to supply licensed BGM; do not silently redistribute reference MP3s.
6. **Later: podcast modes.** Add face-triggered split or camera-switch first; make Pyannote diarization an optional dependency. Support 3+ speakers only after the two-speaker UX is stable.
7. **Later and opt-in: provider integrations.** Gemini/NVIDIA are useful analysis choices, but fal.ai, ElevenLabs, Upload-Post, Pexels, YouTube OAuth, Facebook Graph, and S3/R2 should remain explicit adapters with clear key/status UI. They should never be required for the local Clipflow core.

## License and attribution duties

Both repositories publish their root application under MIT:

- [OpenShorts LICENSE](https://github.com/mutonby/openshorts/blob/main/LICENSE) says the core is MIT and requires retaining the copyright and permission notice in copies/substantial portions.
- [OpenSource Clipping LICENSE](https://github.com/NaufalRizqullah/opensource-clipping/blob/main/LICENSE) is MIT, copyright Muhammad Naufal Rizqullah, with the same notice-retention requirement.

OpenShorts has a material exception: everything under [`cloud/`](https://github.com/mutonby/openshorts/tree/main/cloud) is governed by its separate [OpenShorts Commercial License](https://github.com/mutonby/openshorts/blob/main/cloud/LICENSE), not MIT. That license permits personal/internal self-hosting and modification but prohibits offering the cloud code or derivatives as a hosted/managed/paid service without a separate agreement. Do not copy `cloud/`, cloud dashboard billing, or hosted entitlement code into a commercial Clipflow service. The OpenShorts dashboard files outside `cloud/` are covered by the root MIT notice, subject to checking their dependency licenses.

MIT adoption obligations are small but concrete: preserve both upstream copyright notices and license texts in Clipflow’s third-party notices if source code is reused, mark modified files where practical, and keep a clear attribution entry linking each repository. Reimplementing behavior and layout ideas from the source does not itself require copying code, but copied snippets or modules do.

Third-party runtime/assets need separate review. OpenSource Clipping’s bundled BGM files are not granted by the root MIT text; its [BGM README](https://github.com/NaufalRizqullah/opensource-clipping/blob/main/assets/bgm/README.md) tells users to source royalty-free tracks and mentions Pixabay, YouTube Audio Library, and Incompetech attribution rules. Do not copy those MP3s into Clipflow until each file’s license and attribution are verified. Fonts, model weights, MediaPipe/YOLO/Pyannote assets, Gemini/NVIDIA/fal.ai/ElevenLabs/Pexels APIs, and Upload-Post/social APIs retain their own terms. Clipflow should ship its own notices for any dependency it actually includes.

## Source index

- OpenShorts product/readme and feature claims: [README.md](https://github.com/mutonby/openshorts/blob/main/README.md).
- OpenShorts crop engine: [reframe_v2.py](https://github.com/mutonby/openshorts/blob/main/reframe_v2.py); transcription backends: [transcribe_backends.py](https://github.com/mutonby/openshorts/blob/main/transcribe_backends.py); subtitle burn: [subtitles.py](https://github.com/mutonby/openshorts/blob/main/subtitles.py).
- OpenSource Clipping feature matrix and provider setup: [README.md](https://github.com/NaufalRizqullah/opensource-clipping/blob/main/README.md).
- OpenSource Clipping framing: [Face Tracking and Auto-Framing](https://github.com/NaufalRizqullah/opensource-clipping/blob/main/wiki/4-Face-Tracking-and-Auto-Framing.md); hooks/trimming: [Hook V2 and Segment Trimming](https://github.com/NaufalRizqullah/opensource-clipping/blob/main/wiki/6-Hook-V2-and-Segment-Trimming.md); subtitles: [Subtitles and Typography](https://github.com/NaufalRizqullah/opensource-clipping/blob/main/wiki/7-Subtitles-and-Typography.md); BGM: [BGM and Audio](https://github.com/NaufalRizqullah/opensource-clipping/blob/main/wiki/8-BGM-and-Audio.md); story assembly: [Story Clip Mode](https://github.com/NaufalRizqullah/opensource-clipping/blob/main/wiki/10-Story-Clip-Mode.md).
