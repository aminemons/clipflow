# Validation record

This record distinguishes automated evidence from manual checks and from work that still needs a real provider or hosted account. It covers checks recorded on Windows between 2026-09-19 and 2026-09-21. The commands and browser sessions were run against the source tree available at those dates; rebuild after source changes.

## Automated evidence

- Backend suite: **157 passed, 2 warnings in 47.89s** in a fresh temporary `CLIPFLOW_DATA` directory with local transcription mode. The warnings were Starlette/httpx test-harness deprecations.
- Frontend TypeScript/Vite production build passed with 1,617 modules.
- Frontend `npm test` passed the subtitle import checks and six clip-library regression tests.
- The launcher suite under `tests/` passed separately: **8 passed**.
- Python bytecode compilation passed for `backend` and `launch.py`.
- Backend tests cover imports and uploads, path safety, media ranges, full-source segmentation, transcript edits and SRT, caption rendering, framing, audio edits, export invalidation, batch ZIPs, job deduplication/cancellation, temporary-file cleanup, provider contracts, and hosted-auth boundaries.

## Local workflow evidence

- A fresh YouTube import completed on 2026-09-20 in about 10 seconds for `jNQXAC9IVRw`; the older fixture `BaW_jenozKc` was unavailable and the UI reported the failure without leaving a queued job.
- A 12-second uploaded video was segmented and transcribed through the UI with local Whisper, without an API key. A repeat current-clip transcription reused cached captions.
- Full-source analysis, smart highlight selection, manual ranges, trim, speed, captions, crop/follow framing, mute, denoise, fade, export, MP4 download, and batch ZIP behavior were exercised. Rendered proofs decoded successfully as H.264/AAC video; measured endpoint differences were small, but this is not a perceptual lip-sync benchmark.
- Browser checks covered desktop and 390x844 mobile layouts, refresh persistence, clip delete/undo, transcript corrections, preview seeking, and no horizontal overflow in the checked sessions. The last browser session had no console errors.
- A standalone Arabic/Darija run completed with local Fast/tiny Whisper and produced recognition errors. Larger models were constrained by available memory; no accuracy claim is made.
- OpenCV tracking passed render checks, but a two-detection sample included a graphic false positive. Manual framing can be necessary on graphic-heavy footage.
- On 2026-09-21, the local browser workflow used a synthetic 12-second project at desktop and narrow responsive sizes. Structural clip generation, rename, trim, caption edits, 360p proof rendering, duplicate, keep/discard/restore, selection filters, clear-all/undo, persistence, and batch ZIP download all completed; the real proof reported 360x640 video metadata, 3.8 seconds, and no error. The 23-step tour reached all application pages.
- Responsive checks at 880x560 and 400x680 exposed a collapsed right-panel layout issue that was fixed during the session. The final mobile setup check confirmed a readable step rail, scrolling content, and a reachable Generate button at the bottom of the viewport, without horizontal page overflow.
- Individual MP4 export completed and its browser download event was received. The final browser console check reported no errors.
- The browser file chooser was blocked by the browser's file-URL access setting. A 12 MB multipart upload through the API passed; browser upload itself is not claimed as verified.

## Hosted deployment evidence

- The current hosted layout is Vercel frontend → HTTPS Caddy proxy → one Azure Docker worker, with Supabase Auth for one owner and persistent worker disk for project data and media. Supabase Storage is not part of the data path.
- The configured frontend is [clipflow-aminemons.vercel.app](https://clipflow-aminemons.vercel.app). The worker health route returned HTTP 200 through the HTTPS proxy; unauthenticated session and projects probes returned the expected protected responses. This verifies routing and protection boundaries, not a signed-in owner workflow.
- The hosted deployment uses one in-process worker. Restart behavior, queued-job recovery, persistent volume recovery, and large multipart uploads remain operational checks for the live VM.
- Optional live provider calls were not performed. Mock provider contracts and missing-credential/error handling are covered by tests. No paid provider account or credits are part of this deployment.
- No live paid-provider calls or social publishing actions were performed during the 2026-09-21 checks.

## Known limits and open checks

- Hosted mode is single-owner, single-worker, and uses an in-memory session cookie store. A worker restart signs the owner out and interrupts work that was running.
- Project records, source files, exports, and Whisper models need persistent disk and free space under `CLIPFLOW_DATA`/`CLIPFLOW_MODEL_CACHE`. The current JSON store and one executor are not a multi-tenant or horizontal-scaling design.
- Local mode has no account requirement. Hosted mode requires the exact HTTPS public origin, Supabase URL/publishable key, and configured owner ID; secrets must stay on the worker.
- Local Whisper quality varies with audio, language, and model size. Visual tracking is heuristic. Free highlight ranking uses transcript and structural signals rather than semantic visual understanding.
- Fresh owner login, upload through the Vercel rewrite, a long hosted render, worker restart with persistent data, and optional provider calls should be checked against the live account before describing the hosted path as fully signed off.
