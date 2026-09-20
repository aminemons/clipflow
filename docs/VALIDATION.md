# Validation

Checked on Windows on 2026-09-19 with Python 3.11, FFmpeg/FFprobe, OpenCV 4.14, and local Whisper tiny.

## Automated checks

Final `python -m pytest -q`: **67 passed, 2 warnings in 71.09s**. The warnings are deprecations in the Starlette/httpx test harness. This run limited OMP, MKL, and OpenBLAS to two threads and ran without the app concurrently loading a speech model. A preceding rerun exhausted system memory; its failure is not counted as a pass.

## Latest usability checks

- New project is available from the header and Import another video. Both open the same upload/YouTube dialog. A real browser file upload while another project was open created a separate project, switched to it when ready, and preserved the previous source. The YouTube input enables its import action for a pasted URL; a fresh YouTube download was not repeated in this check.

- Browser Clear clips removed all four test clips; Undo remove restored their IDs, ranges, edits, and exported status. Work on this clip checked only the chosen clip for export.
- On the 21-minute source, Focus clip zoomed to 28×; Fit source returned to 1× and showed the entire source. Keyboard End sought to 21:01. Refresh restored the working project.
- At 1365×900 and 1365×768, the preview label ends 28 pixels above the timeline. The 390×844 mobile check had no horizontal overflow and a 22-pixel gap above the timeline.
- Scoped transcript offsets, cached reuse, preserved corrections, inherited passage captions, and immutable HTTP download paths pass automated tests.
- A final live 8.62-second clip export completed in 20 seconds, returned its job-specific MP4 URL, and downloaded successfully over HTTP.
- A standalone small-model Arabic run completed in about 39 seconds for 12 seconds of audio, with recognition errors. Two live small-model attempts failed due to memory allocation limits. The service now reports a readable recovery message, clears the model cache after memory failure, and never silently downgrades the model. No claim of accurate Darija recognition is made.
- The production TypeScript/Vite build passed. Obsolete generated app bundles and regenerable workspace Python bytecode were removed; source media and exports were preserved.

Tests cover full-source segmentation, uploads, media ranges, invalid input/path traversal, editing and export invalidation, moving-subject follow rendering, fit/manual cropping, preserved audio, caption pixels and timed SRT events, batch ZIPs, job deduplication, cancellation, temporary-file cleanup, and provider contracts. TypeScript and Vite production build passed. No browser console errors were observed in the final editor session.

## Real workflow checks

- The existing 1261.274-second, 1920x1080 YouTube source produced 42 editable clips covering its full duration. Live analysis completed in about 25 seconds. This checks processing of an already imported source, not a new YouTube download.
- A 12-second video was uploaded through the browser and segmented successfully. Local Whisper transcribed it through the UI in about 14 seconds, producing four timed segments without an API key.
- Numeric trimming, smoothing off, and center caption positioning persisted. The four-second portrait proof was played and inspected as a rendered frame: 720x1280 H.264, AAC audio, and visible Arabic captions.
- Export completed and the browser MP4 download triggered successfully. Automated tests separately checked batch ZIP contents and audio preservation.
- Retrying an interrupted demo completed successfully. Resolved development failures were archived to the task scratch audit while cleaning the live job list; media and edits were preserved.
- Neue Einstellung loaded successfully. Desktop checks verified the preview stays above the timeline and header remains visible. A 390x844 responsive check showed no horizontal overflow.
- Connections reports available tools and disables Higgsfield generation until both credentials are configured.

## Smart clipping and editor checks

- Browser smart analysis produced a selected six-second highlight from the twelve-second speech source; previous clips remained available and deselected. A prior five-second request also completed successfully.
- Automated tests cover topic relevance, duration tolerance, non-overlap, repeated text, silent footage, short sources, invalid hosted responses, missing credentials, and preservation of earlier clip edits.
- Dragged caption coordinates persisted. A real 6.006-second proof rendered at 720x1280 with H.264 video, AAC audio, and the repositioned burned captions.
- Expanded preview keeps the same video element and preserves the paused playhead (6.954672 seconds before and after closing in the browser check). Playback controls sit below the image.
- Numeric duration entry accepted 30 without clamping mid-entry. Full-video mode retains its duration control. Smart mode exposes tolerance, maximum count, topic, transcript use, and provider.
- Settings saved the optional Higgsfield toggle without restarting. API tests verify credential persistence/removal, secret-free responses, rejected foreign origins, and input validation. No real API keys were entered during these checks.
- TypeScript/Vite production build passed; the final browser session reported no console errors.

## Transcript and sound tests

- Corrections persist without changing timestamps, update SRT, invalidate automatic caption exports, and preserve manual overlays. Empty corrected passages are omitted from captions. Invalid edits and concurrent media jobs are rejected.
- Creating a clip from a transcript interval preserves existing clips and uses the selected source timestamps.
- Actual FFmpeg renders verify shortened duration at 2× speed, preserved audio/video streams, mute energy below -70 dB, and reduced PCM energy at the beginning of an audible fade.
- Follow, fit, manual, and video-only sources pass effect rendering checks. Standalone SRT timestamps include the original clip offset and playback speed; caption burn-in uses unscaled times before the final speed pass.
- API checks reject invalid speed, volume, fade, and denoise settings and verify that valid edits invalidate old exports.
- Live browser check: saved a transcript punctuation correction, selected two passages, and created a new 0–8.62-second clip without removing earlier clips. Speed, mute/unmute, denoise, and a 0.5-second fade persisted through the API.
- The processed proof was a 4.367-second, 720x1280 H.264/AAC video at 2× speed. Seeking from that proof to passage 3 switched to the source at 8.62 seconds with source playback rate 2×.
- Final TypeScript/Vite production build passed. Desktop (1280px) and mobile (390px) checks found no horizontal overflow; all four sidebar tabs fit. Browser console errors: none.
- The same passage clip completed a separate MP4 export job at 100%, with a working download response.

## Provider and deployment limits

Groq and Higgsfield were tested with mocked HTTP responses, including authentication/credit errors and download handling. No paid generation, hosted ranking, or live hosted transcription was attempted. Add credentials in Settings to test with your account; settings apply without restarting. Manual `.env` edits require a restart.

Tiny Whisper prioritizes speed; recognition accuracy varies by audio and language. Choose a larger model in Settings or configure Groq for another transcription option. Tracking uses faces and a saliency fallback; it is not active-speaker tracking. Free highlights use transcript relevance and structural heuristics, not visual semantic understanding.

The application runs as a single-user local service. Public multi-user deployment, authentication, distributed workers, and Docker startup were not exercised.

## Current validation evidence — 2026-09-20

- Backend full suite: **85 passed, 2 warnings in 106.41s**. Two later export-revision tests were covered separately with the hosting/job-control subset: **17 passed, 3.99s**. These are separate runs; no combined 87-test result is claimed.
- The latest frontend TypeScript/Vite build passed with 1595 modules, including the extracted `PreviewPlayer` and `ProviderSettings` paths.
- `work/rebuild-smoke-report.json` for QA project `bc2e04197bc3` records upload, full coverage, trim plus 1.25× speed, caption rendering at 360×640, video duration 6.433 seconds, audio duration 6.409 seconds, batch count 2, immutable prior export, strict-max smart clipping, keep/discard/review, and delete/restore.
- Chrome access to the Amine account and authenticated Vercel Hobby and Supabase Free dashboards is verified. No persistent worker host has been supplied, so there is no live cloud deployment or hosted media round trip to claim.
- Fresh YouTube import of `jNQXAC9IVRw` completed on 2026-09-20 in about 10 seconds (project `70e24e7e8b1a`). The older yt-dlp fixture `BaW_jenozKc` returned “This video is unavailable”; the app reported that failure without remaining queued.
- Current-clip Arabic/Darija recognition on an eight-second range using Fast/tiny completed in 22.25 seconds; the repeat reused saved captions in 0.56 seconds. Output still contains recognition errors. This is a timing/cache measurement, not evidence of acceptable Darija accuracy. Balanced/small previously took about 39 seconds for 12 seconds of speech; low-memory attempts also failed. Thorough/large-v3 was not run on this resource-constrained machine.
- A decoded proof frame was inspected: face remains visible, caption is near the requested 90% vertical position. FFmpeg decoded the complete proof without errors. The measured audio/video endpoint difference is 25 ms; perceptual lip-sync and intelligibility are not established by that measurement.
- The latest build could not receive a fresh browser interaction pass: Chrome remained connected and listed authenticated tabs, but control returned “Debugger unattached” and timeouts. Earlier browser results above apply to the earlier build. The new save/review/trim interactions have code/build/API evidence, not a new browser sign-off.
- Hosted media, live provider keys, a representative Darija accuracy benchmark, and a real multi-speaker speech benchmark remain unverified. No live cloud provider or deployment result is implied by mock auth tests.

### Delivery and final checks

- The fresh YouTube source was also trimmed, captioned and exported: 360×640 video and AAC audio both measure exactly 4.000 seconds.
- A two-detection scene from the existing 21-minute source was tested with left/right preference. Visual inspection showed that one detection was a graphic emblem, not a face; the other was a portrait. This exposes a Haar false positive and is **not** a successful multiple-person benchmark. Graphic-heavy material can need manual framing; no identity or active-speaker accuracy is claimed.
- Restarted the worker and verified the latest frontend plus all five original projects and their clip counts. Four disposable QA projects were moved, with their media and job-record backup, to `work/rebuild-verification-archive`; original user projects were preserved.
- Source is published at https://github.com/aminemons/clipflow (private). No environment secrets, user media, speech models or private font binaries were included. GitHub Actions configuration is supplied as `docs/github-actions.example.yml`: the authenticated OAuth scope could not publish files under `.github/workflows`.
- No cloud deployment has been completed. Vercel and Supabase dashboard sign-in is confirmed, but there is no configured persistent HTTPS worker host or Supabase owner configuration. Live Chrome control stopped responding after sign-in verification.
