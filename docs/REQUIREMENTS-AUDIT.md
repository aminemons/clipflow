# Requirements audit

Status checked 19 September 2026 against the requested local-first editor, smart-highlights, transcription, sound controls, and export workflow. “Verified” means covered by the final automated suite or a recorded local workflow check. Provider claims without credentials are marked separately.

## Delivered and verified

| Requirement | Status | Evidence or boundary |
|---|---|---|
| Local video import, YouTube ingestion, project persistence, editable clip ranges, MP4/SRT/ZIP export | Verified | Existing backend and browser checks; no account is required for the local path. |
| Scene/silence segmentation and 9:16 fit, manual, and follow framing | Verified | Automated media/render checks, including moving-subject follow output. Tracking is a face/saliency heuristic. |
| Captions with transcript search, correction, source passage clip creation, manual captions, position/style controls | Verified | Transcript and caption tests plus browser checks. Manual caption text is kept separate from automatic transcript text. |
| Smart highlights with target duration, fractional tolerance, limit, topic, bounded local ranking, structural silent fallback, and optional Groq ranking | Verified locally and with mocked hosted responses | Local ranking uses transcript evidence and scene/silence structure. It does not infer pictured events or predict virality. No live Groq request was made. |
| Better speech options | Verified in tests and local smoke check | Language auto/Arabic/French/English, Algerian dialect hint, fast/balanced/accurate quality, prompts, local model cache reuse, Groq model selection, and clip-scoped transcript settings are implemented. |
| Sound and pace controls | Verified | Speed 0.5×–2×, volume 0–200%, FFmpeg denoise, fades, pitch-preserving audio tempo, video-only handling, and SRT timing are tested. |
| Non-destructive editing and selection | Verified | Existing clips and edits survive smart analysis; current selection and export selection are handled separately; bulk clear/delete and undo are covered. |
| Timeline usability | Verified | Zoomed timeline, source playhead seeking, transcript passage selection, expanded preview, and responsive layout checks passed. |
| Immutable export artifacts | Verified for new export jobs | Job-specific clip snapshots and ZIPs live under `files/<project>/exports/<job>/`. Earlier legacy URLs retain their previous behavior. |
| Local security boundaries | Verified for tested local scope | Identifier and path validation, localhost origin checks, server-only credentials, and no raw key logging are covered. |

## Partially delivered or intentionally bounded

- The local selector is a deterministic baseline. It uses speech coverage, topic matches, distinct wording, silence, and scene boundaries. It does not provide visual semantic understanding, emotion detection, active-speaker identity, or a meaningful “viral score.”
- Algerian Darija receives Arabic language selection and a context hint. The local smoke test used a 12-second Arabic recording, took about 39 seconds on CPU, and still contained recognition errors. No Darija accuracy guarantee is made.
- The new small model is installed at `E:\CodexClipflowCache\models` for local validation. Accurate/large models require a suitable cache drive or Groq; the preflight reports insufficient storage instead of silently falling back to tiny.
- New export jobs are immutable. Historical `/clips/<clip>/download` links still serve the latest render at that old path; previously overwritten versions cannot be recovered.
- A live 8.62-second small-model attempt hit the machine's memory limit. CPU threads and Balanced beam size were reduced, with cache cleanup and an actionable memory error added. The retry still exceeded available memory. This machine cannot currently be counted as a successful live small-model deployment.
- The original 48-hour deadline depends on when the recruiter sent the test; that receipt time was not provided.
- The editor is designed for one local user. It has no authentication, multi-user authorization, distributed job isolation, or hardened public deployment profile.

## Not verified or not delivered

- Groq transcription, Groq smart highlights, and Higgsfield generation were tested with mocks only. No live key, account, credit, or paid request was used.
- GitHub publication or pull-request delivery was not completed.
- Redistribution rights for the local Neue Einstellung font files were not verified. The build retains the local assets for the authorized workspace; redistribution needs the font owner’s license confirmation.
- Cross-platform packaging, Docker startup, and large GPU model performance were not part of the final validation.

## Validation record

- Earlier full automated run: **64 tests passed**. Later targeted checks passed for clip transcript inheritance, immutable HTTP downloads, and memory-failure handling. Final rerun results are recorded in `VALIDATION.md`.
- The checks include media rendering, audio/video streams, mute and fade energy, follow/fit/manual framing, transcript options, smart ranking, cancellation and cleanup, settings validation, path traversal, export snapshots, and mocked provider failures.
- The local Arabic smoke run completed but exposed recognition errors described above. This is evidence that the path runs, not an accuracy benchmark.

## Research basis

The implementation uses the public APIs and interaction patterns below as references; it does not copy their proprietary code or claim feature parity.

- [OpenAI Whisper](https://github.com/openai/whisper) establishes the speech-recognition model family and language/task concepts.
- [SYSTRAN faster-whisper](https://github.com/SYSTRAN/faster-whisper) documents the CTranslate2 implementation and options used here: language, `task="transcribe"`, beam size, VAD, `initial_prompt`, and `condition_on_previous_text`.
- [LosslessCut](https://github.com/mifi/lossless-cut) informed the non-destructive source/range workflow. Its timeline references include [`useTimelineScroll`](https://github.com/mifi/lossless-cut/search?q=useTimelineScroll&type=code) and [`useSegments`](https://github.com/mifi/lossless-cut/search?q=useSegments&type=code), which reinforce keeping timeline state separate from rendered files.
- [OpenCut issue 456](https://github.com/OpenCut-app/OpenCut/issues/456) and [pull request 409](https://github.com/OpenCut-app/OpenCut/pull/409) were reviewed for timeline/editor interaction and segment handling. Clipflow adopts the general concepts—editable ranges, visible timeline state, and non-destructive operations—through its own implementation.

These references support the product decisions: keep source media intact, represent clips as editable ranges, make expensive renders explicit, and preserve a usable local path when hosted services are unavailable.
