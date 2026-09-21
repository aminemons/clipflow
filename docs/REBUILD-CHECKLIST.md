# Rebuild acceptance checklist

Updated 2026-09-20. API/media verification and browser verification are distinguished below. See [validation](VALIDATION.md) for measurements and [architecture](ARCHITECTURE.md) for deployment scope.

| Requirement | Current result | Remaining limit |
|---|---|---|
| Preserve existing projects | Source/metadata backup before edits; additive schema and last-valid recovery tests pass | Original media still needs ordinary user backups |
| Upload and YouTube | Fresh file upload and fresh YouTube download succeeded | Private/gated/unavailable sources depend on upstream access |
| Complete-source segmentation | API smoke verifies contiguous full coverage; concurrent-edit guard tested | New UI interaction pass blocked by Chrome control |
| Select useful highlights | Target/tolerance/strict maximum/count/topic, local ranking and structural fallback; smart smoke passes | Local ranking is heuristic; Groq ranking only mock-tested |
| Highlight review | Reasons; keep/discard/restore; regeneration preserves earlier edits and decisions | New browser review pass pending |
| Trim/extend | Numeric ranges, draggable/keyboard boundaries; actual extended render passes | New timeline browser pass pending |
| Follow subject | Face association, left/right preference, saliency fallback; moving-subject render tests | Not speaker/identity tracking; crossings need manual correction |
| MP4 and batch export | Real MP4/ZIP, immutable prior export, revision guards, full decode pass | Live hosted download unverified |
| Free local workflow | Upload → segment → edit → proof → export runs without keys | First setup/model download needs internet and disk |
| Transcription | Language/quality/Darija hint/current-clip/cache/corrections; 22.25s recognition vs 0.56s reuse | Fast model still makes errors; no dialect accuracy claim |
| Clip library | Active clip independent of export checkboxes; reviewed filter, recoverable delete-all, export history | Final interactions code-reviewed, not newly browser-tested |
| Timeline and preview | Zoom/fit/source/clip focus, bounded playback, expanded preview keeps element | Source framing/effects are explicitly approximate |
| Captions/audio | Drag and numeric placement; style/visibility; speed, volume/mute, denoise, fades render | Render proof required for final effects; no perceptual listening benchmark |
| Save/undo/redo | Serialized saves, retained failed patches/retry, revision-aware history, refresh persistence | New browser fault-injection pass pending |
| Jobs | Persistent records; cancel acknowledgement, retry, restart validation tested | Interrupted work is retried manually, one worker only |
| Consistency/storage | Snapshot exports, stale preview rejection, atomic metadata/backups, space preflight/failed-output cleanup | No distributed queue or shared multi-tenant store |
| Providers/settings | Server-side masked/removable Groq/Higgsfield credentials; adapters mock-tested | No successful live provider requests |
| Research | Three repositories traced through source; competitors and license decisions linked | No unlicensed code/assets copied |
| Hosted authorization | Fail-closed owner-only Supabase adapter; live owner login, authenticated projects, anonymous rejection, and foreign-origin rejection checked | Single private workspace only; restart signs out the in-memory session |
| Deployment | Vercel frontend and Azure Docker worker are live behind HTTPS Caddy; health and proxy/auth boundaries checked | Large multipart upload through Vercel, restart recovery, and long hosted render remain operational checks |
| Source/handover | Private [GitHub repository](https://github.com/aminemons/clipflow), setup, env example, architecture, research, validation and demo instructions | Recruiter needs repository access; CI example is not enabled |

## Validation and recovery

Backend: 85 tests passed in the full suite; 17 passed in a later focused run covering the two added export-revision tests. These are separate overlapping runs. Latest TypeScript/Vite production build passed (1595 modules). The live QA report for project `bc2e04197bc3` confirms 360×640 H.264/AAC output, 1.25× speed, batch count 2, immutable exports, strict-max suggestions and delete/restore. See VALIDATION.md for exact scope.

Pre-rebuild source and project/job metadata are in `work/rebuild-backup-20260920` beside the repository. Original videos remain in the data directory. First legacy saves retain `.json.v1.bak`; later saves retain a last-valid `.json.bak`. User projects and secrets are excluded from source delivery.

Final restart preserved all five original projects. Disposable QA projects were archived outside the source repository. A real-media tracking probe exposed a graphic being detected as a face; multiple-person accuracy remains unverified, and manual focus remains necessary for such scenes.
