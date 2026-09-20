# Editing and previewing clips

Import a file or inspect a YouTube link and choose its download quality. Importing
never starts clipping. Choose **Create clips automatically** for local speech
ranking, adaptive framing and captions, or configure the five setup steps yourself.
Automatic processing can download a free speech model on first use.

In manual moments, move the source playhead, set the start and end, then add the
displayed range. A topic enables speech ranking automatically; local ranking uses
transcript terms and scene/pause signals, not human-level semantic understanding.

The numbered clip library selects the clip being edited. Rename it in Trim or with
the pencil next to its title. Media edits are drafts: **Save settings** persists them,
then **Render preview** generates the actual camera movement and effects. Saving
does not start rendering. Navigation warns about unsaved drafts; browser close or
refresh uses the browser's unsaved-work prompt. Export renders saved settings.

The source player shows the full source for automatic framing. It does not pretend
to show an analyzed crop. The rendered preview is the final composition.

## Camera

Adaptive OpenCV analysis conservatively preserves distributed diagrams and screen
content with fit or blurred background. Face boxes cap zoom; a final viewport check
falls back to the full frame when all detected faces cannot fit. This is heuristic
tracking, not speaker identification. Explicit keyframes override automatic paths.

Choosing Gemini visual analysis sends at most six sampled frames to Google's API.
Set `GEMINI_API_KEY` in Settings; optionally set `GEMINI_VISION_MODEL` in the server
environment. No frames are sent with the default local choice. Invalid or failed
responses fall back to local framing. Provider costs and model availability belong
to the account used. Live provider quality requires testing with your own footage.

## Captions

Outfit, Anton and Noto Sans Arabic are bundled with their OFL licenses. Font, size,
color and draggable placement apply to preview and export. Arabic text uses Noto
Sans Arabic for glyph coverage. Long speech segments are divided into cues of up
to six words using proportional timings; these are not forced-aligned word timings.
Correct recognition mistakes in Transcript before exporting.

All core clipping, framing and rendering works without paid API keys. Publishing
requires platform-specific account credentials and explicit approval in Publish.
