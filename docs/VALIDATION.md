# Validation record

Evidence current through 2026-09-23. This record distinguishes completed checks
from remaining release and provider limits.

## Automated checks

- Full Python suite on the current source, including the YouTube-unavailable classifier regression fix: **215 passed**.
- Frontend subtitle and clip-library tests passed; production build passed.
- Desktop bundle verification (`verify_bundle`) and packaged `--self-test` passed.
- A real FFmpeg render test passed with word-timed captions in the export path.
- A synthetic spoken WAV passed through the bundled offline Whisper Small model:
  two segments and 11 aligned words were returned without a network request.

The 2026-09-23 source changes retain word timing from local Whisper and Groq,
use it for captions and highlight boundaries, and make model-ranked clip IDs
honor the provider's order. Provider integration checks used mocked responses;
no live paid provider request was made. The frontend production deployment
and Azure worker were updated through revision `91faa45`. The worker health
check returned HTTP 200, and its live classifier returned `youtube_unavailable`
for an unavailable-video error. Windows package workflow `35895195102` passed
and produced the [public release ZIP](https://github.com/aminemons/clipflow/releases/download/desktop-91faa4507c0d75f811a671957f573f9c11a30b9d/Clipflow-windows-x64.zip).
Its SHA-256 is
`98900d6982a4d76aaaf1ea2bdc4a4645ed0d850f219e7253982f653c8297ee59`.

## Hosted deployment

- Vercel production is Ready at revision `91faa45`. The Azure worker was
  rebuilt with the corrected classifier and
  returned HTTP 200 from its health check.
- An authenticated hosted smoke check completed synthetic upload, automatic
  clip generation, proof, and export; the resulting download link appeared. This
  does not confirm playback of a downloaded file.
- YouTube hosted downloads can still encounter provider anti-bot blocks. A live
  request for public video `jNQXAC9IVRw` returned a bot prompt after a bounded
  retry. An isolated, cookie-free `bgutil` 2.0.0 PO-token-provider test against
  the same video also returned the bot prompt. The test containers and network
  were removed; the production worker remained healthy. Hosted import
  availability is not considered resolved.
- A public [Cobalt API](https://github.com/imputnet/cobalt/blob/main/docs/api.md)
  instance is not a supported backend: its operators do not permit use by other
  projects without permission. Self-hosting it on this Azure VM would still use
  the same blocked egress IP.

## Local desktop workflow

- The package build at `91faa45` passed bundle verification and an extracted
  package self-test. A separate local end-to-end check used a synthetic
  eight-second source: Smart and Full-source modes both generated and exported
  720×1280 H.264/AAC files, confirmed with FFprobe. Temporary test files were
  removed.
- Windows package workflow `35895195102` passed, and the public release ZIP is
  available with SHA-256
  `98900d6982a4d76aaaf1ea2bdc4a4645ed0d850f219e7253982f653c8297ee59`.

## Remaining limits

- Hosted mode is single-owner and single-worker. Worker restarts interrupt
  running work and sign the owner out; persistent storage and recovery still
  require operational monitoring.
- YouTube availability depends on upstream behavior and may be blocked by
  anti-bot checks.
- Local transcription depends on available memory and the selected model;
  visual tracking and free highlight ranking are heuristic.
- The original assessment password was rotated. The current shared credentials
  are published in the README at the owner's request; this workspace should
  contain only non-private test material.
