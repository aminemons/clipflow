# Clipflow requirement audit — 20 September 2026

This replaces earlier broad completion claims. Passing unit tests does not prove the whole product works on every source.

| User requirement | Implementation and actual verification |
| --- | --- |
| Windows desktop starts | Python.NET pin, startup logging and browser fallback implemented. Native startup verified in the previous package; replacement package must also pass media playback and rendering. |
| Desktop source playback | Found Windows final-path resolution incorrectly rejecting an existing source. Fixed lexical containment with symlink/junction rejection. Regression and source-range tests passed. |
| Upload and YouTube quality selection | Implemented. This run exercises fresh file upload through processing; current YouTube/network provider conditions are not guaranteed. |
| One-click automatic workflow | Explicit button, model readiness, automatic model selection, visual-only fallback on silent sources. Actual speech generation verified. |
| Speech accuracy, including Algerian Arabic | NOT solved universally. Tiny Whisper returns inaccurate Arabic on the test recording. UI warns about draft quality; explicit larger models and Groq remain choices, subject to resources/keys. |
| Smart moments, topic and target length | Local transcript/scene ranking and optional language-model adapters. Topic enables speech; manual/full/smart modes remain separate. Semantic quality is not established by the presence of an adapter. |
| Manual start/end controls | Moved to manual range selection with visible range values and add action. |
| Scrolling and hidden actions | Setup owns its scroll and has a sticky footer; short-window check performed in the previous run. |
| Save before rendering | Explicit draft/save/render states. Browser check verified rendering disabled while unsaved and enabled after saving. |
| Names and numbering | Numbered clip list, pencil rename and Trim name field implemented. |
| Smart camera | Conservative diagram preservation, face/viewport safety, authored keyframes and optional Gemini sampled-frame plans. This run found and fixed a real NumPy face-detection render crash. It is not active-speaker recognition. |
| Caption appearance and placement | Bundled OFL fonts, Arabic glyph fallback, sizing, draggable placement, presets and short timed cues. Render checked; short cues use proportional segment timing, not word alignment. |
| Tutorial | Versioned first-use tour and replay action with setup/editor targets. |
| Individual and batch export | MP4/SRT/ZIP paths implemented. This run checks actual preview and export after automatic generation. |
| Clean library and desktop bundle | Previous sources archived with recovery; package excludes source videos and credentials. New verification projects archived after completion. |
| Paid integrations and publishing | Adapters exist. Live provider output, publishing permissions and paid-account success remain UNVERIFIED without configured credentials. |
| Public hosted app | NOT deployed. Vercel Hobby account confirmed signed in. Current architecture requires a persistent Python/FFmpeg worker; Supabase alone does not host it. |
| Clean code and instructions | Source, desktop launcher, regression tests and editing/setup documentation included. No claim of zero defects. |

## Validation scope

The configured Python environment is `work/.venv`, with the installed OpenCV/speech dependencies on PYTHONPATH. Running a different system Python is not a valid dependency test of this environment. The full suite returned 160 passed before the final face-array regression and silent-source test were added; focused checks cover those final changes separately.

Live test sequence: upload a 12-second speech video, serve a byte range, inspect model readiness, generate a clip with real faster-whisper, rename it, render its camera/captions, and export it. The initial render exposed the face-array bug; its retry is recorded separately. Desktop verification must use the packaged executable and its own API, not only a server startup self-test.

## Final results for this revision

- Web: fresh upload, byte-range playback, real Whisper transcription, automatic clip generation, title/settings save, preview and MP4 export completed. Verification project archived.
- Tests: 160 passed in the full configured suite; 27 focused camera/vision/generation/speech checks passed after the final array and silent-source fixes.
- Packaged desktop: actual source served HTTP 206, 3-second captioned clip generation completed, immutable preview and exported MP4 each returned HTTP 200 (99,933 bytes). The desktop window was left running.
- Final Windows ZIP SHA-256: A89E5196C42AABF31F9D18457C8502E7713118B63B5C45343EC24DF699F3409B.
- Public deployment, live paid-provider quality and reliable Algerian Darija recognition remain incomplete. These are not covered by the successful local workflow checks.
