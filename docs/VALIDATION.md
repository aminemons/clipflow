# Validation record

Evidence current through 2026-09-23. This record distinguishes completed checks
from remaining release and provider limits.

## Automated checks

- Full Python suite on the current source tree: **202 passed**.
- Frontend subtitle and clip-library tests passed; production build passed.
- Desktop bundle verification (`verify_bundle`) and packaged `--self-test` passed.
- A real FFmpeg render test passed with word-timed captions in the export path.
- A synthetic spoken WAV passed through the bundled offline Whisper Small model:
  two segments and 11 aligned words were returned without a network request.

The 2026-09-23 source changes retain word timing from local Whisper and Groq,
use it for captions and highlight boundaries, and make model-ranked clip IDs
honor the provider's order. Provider integration checks used mocked responses;
no live paid provider request was made. The published desktop ZIP and hosted
worker still run the earlier build until rebuilt and deployed.

## Hosted deployment

- Vercel deployment for commit `453bccc` succeeded. The Azure worker is deployed
  and healthy.
- Authenticated hosted smoke testing on `3df22f1` completed synthetic upload,
  generation, editing, preview, MP4 export and download, and permanent project
  deletion. On the latest commit, `453bccc`, login and project reads passed.
- YouTube hosted downloads can still encounter provider anti-bot blocks. A live
  YouTube request returned that condition; it is not considered resolved.

## Local desktop workflow

- The packaged build at `453bccc` passed bundle verification and self-test. A
  real seven-second synthetic upload completed one-click generation, preview,
  MP4 export and download, and project deletion.
- On this PC, offline Whisper Small ran out of memory. One-click generation
  correctly fell back to visual clips with captions disabled and displayed a
  warning. An earlier package on this PC processed an 11-minute source into five
  captioned clips; that result does not establish Small-model operation on the
  current package or under current memory conditions.
- The Windows ZIP was assembled and published on 2026-09-22. Its SHA-256 is
  `f5b4e5eb5121d2c3e88dfa39184f5fe280e6da9c415aab8590a5c8c76fc7119e`;
  every archive entry passed CRC validation, required runtime/model files were
  present, and the authenticated site returned the new 846,479,834-byte archive
  with HTTP 206 range support. A fresh Windows extraction was not run because
  the test machine did not have space for a second copy of the package.

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
