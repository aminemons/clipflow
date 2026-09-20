# Configure, generate, edit, publish

Imports save the original source. They do not create clips. YouTube imports first inspect the video and ask for download quality.

1. Open Clip setup. Review the source, then choose suggested moments, full-source segmentation, or manual time ranges.
2. Configure camera framing and output size. Automatic face-size zoom is optional and stays under the chosen maximum. Manual keyframes override tracking.
3. Choose automatic captions, a manual text overlay, or no captions. Speech language and quality can be set before recognition. Review audio and the full setup.
4. Generate clips. The worker prepares a complete batch before committing it; failures and cancellations keep existing clips intact. Existing edits and exports are preserved.
5. Select a result in Edit clips. Timing, captions, audio, framing and camera keyframes belong to that clip. Render a proof to inspect actual tracking, then export one or several clips.
6. Add named destinations in Settings > Publishing. Approve rendered exports, choose the accounts, and review the publishing plan before confirming. Account configuration changes invalidate pending plans. Each destination records its own outcome; uncertain requests are not automatically retried.

## What automatic processing does

Without speech analysis, suggestions use scene changes and pauses. They do not understand the video's meaning. Local transcript ranking uses sentence and topic signals; configured language models can rank transcript content. Every suggestion remains editable. Neither method guarantees an engaging or complete story, so review the proposed boundaries.

The camera associates face detections across frames, falls back to visual motion, resets at scene changes, and limits movement speed. Optional face-size zoom aims to keep a detected face near 30% of crop height, bounded by the user's maximum; motion-only detections return to a wider view. It does not identify the active speaker from audio. Manual camera keyframes remain available when automatic framing picks the wrong subject.

## Verification

The combined backend and integration suite passed 149 tests. Frontend compilation and subtitle parser tests passed. Browser checks covered setup through manual generation, caption settings carried into the generated clip, independent editing, a second smart generation preserving the existing clip, rendered proof, MP4/ZIP export, account addition, and a 390px viewport without horizontal page overflow. Publishing tests use fake providers; no social account has been posted to during validation.

Online hosting still requires a persistent worker with FFmpeg, media storage and the hosted authentication settings in HOSTING.md. The local web app and portable desktop bundle use the same processing code. Optional provider keys and social credentials are entered through Settings.
