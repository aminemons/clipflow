# Local workspace rebuild

The app opens into a project library. A persistent sidebar separates Projects, Editor, Exports, and Settings. An open editor stays mounted while navigating, so the working clip and playhead are not lost. Imports create independent projects. Archive is reversible and never removes source media.

Visual direction: white `#ffffff` surfaces, cool canvas `#f5f6f9`, ink `#202632`, secondary text `#657084`, borders `#e2e6ed`, and one blue `#4058d6` action color. Neue Einstellung remains the user's local font; portable builds use OFL Outfit. Normal controls are at least 13px and page text 15px. Media thumbnails, selection, and editable controls provide the hierarchy; no decorative metric cards or background gradients.

```
Navigation | Projects: search / filter / sort / grid or list
           | Recent project + media library

Navigation | Project title / save status / undo / redo
           | Tool tabs | video preview | clips or transcript
           |           | timeline      |
```

Reference review: adopt OpenShorts' separation of production tools and persistent navigation, and OSC Studio's grouped job settings. Keep the source preview and actual rendering explicitly distinct. Use our own Clipflow identity and maintain the free local pipeline. New features require working persisted operations, rather than decorative switches.

The first-run walkthrough points to live controls and is replayable. Keyboard focus, reduced motion, responsive navigation, and recoverable archive are part of the implementation, not later additions. License/repository findings are in NEW-REFERENCES.md.

## Implemented behavior

- Persistent Projects / Editor / Exports / Settings navigation with browser history. Pending clip saves are flushed before navigation; failed saves keep the editor open.
- Project search, tags, favorites, sorting, grid/list layout, rename, archive and restore. Existing project data is migrated without replacing unknown fields.
- Separate Clipping, Layout, Captions and Audio inspector tabs; the working clip stays separate from export selection. Timeline zoom and expanded preview are retained.
- SRT/WebVTT parsing and explicit transcript replacement, preserving clip-specific transcripts and manual captions. Built-in and custom browser-saved caption presets can be applied to one clip or all clips.
- Actual 9:16, 1:1, 4:5 and 16:9 rendering through FFmpeg/OpenCV, plus blurred-background fit. Caption positions use the chosen aspect ratio.
- Export history with filters, MP4 playback and downloads; processing status, cancel and retry. Previous rendered versions stay separate from current edits.
- Storage summary and guarded cleanup of temporary proof videos. Cleanup leaves sources and exports intact and cannot race a newly submitted job.
- First-visit welcome, ten-step spotlight tour with a loaded project, replay, skip, keyboard focus containment and narrow-screen navigation.

## Browser and end-to-end validation

Validated in Chrome on 2026-09-20, desktop and 390×844 viewport: search, name/tags persistence, favorite, list/grid, archive/restore, editor navigation, timeline zoom, expanded preview, all ten tour steps, export playback dialog, and storage/settings views. The six existing user projects were retained; the new MIT source still has its 16 clips. A separate verification project was archived after testing.

An HTTP check imported English/Arabic subtitles, rendered a proof, exported a six-second 360×360 clip with blurred background, downloaded and probed it, and inspected an Arabic-caption frame. Preview cleanup freed 124,673 bytes from that sample and left its source/export intact. No external provider requests were made.

Frontend `tsc -b && vite build` passes. `npm test` in `frontend` exercises timestamp parsing, malformed cues, comment blocks, limits, clipping to the source duration, and Arabic text. Chrome extension file selection was blocked by its file-URL setting, so file chooser automation could not complete; the subtitle parser and import/render API path were tested separately. Manual browser selection remains available to the user.

## Practical limits

Speech recognition remains dependent on the recording, language, model, and hardware; these changes do not establish Algerian Darija accuracy. Source preview approximates moving crops; Render proof uses the final renderer. Optional Groq/Higgsfield connections require account keys and were not live-tested in this rebuild. This delivery remains local and was not pushed or deployed.

## Validation

Backend validation after the final project-management lock ordering fix:

```
work/.venv/Scripts/python.exe -m pytest backend/tests -q
94 passed, 2 warnings in 14.75s
```

The warnings are existing Starlette/httpx and AnyIO deprecation notices from the test client.
