# Recoverable temporary-file cleanup

Audit date: 2026-09-19.

The following nine inactive-looking browser profile directories were verified as exact paths under `C:\idh` and had no exact command-line process match during the read-only audit:

- `.codex-browser-smoke`
- `.codex-browser-smoke-date`
- `.codex-browser-smoke-e2e`
- `.codex-browser-smoke-e2e2`
- `.codex-browser-smoke-flight`
- `.codex-browser-smoke-flight2`
- `.codex-browser-smoke-flight3`
- `.tmp\product-pages-cdp`
- `.tmp\prod-mobile-audit`

The measured source total was approximately 735 MB. The intended recoverable destination was `D:\CodexClipflowBuild\recovered-idh-temp`.

No files were deleted. The authorized `Move-Item` operation was attempted after verifying the exact sources and destination. Windows returned `Access to the path is denied` during the cross-volume move, and the post-check confirmed all nine source directories remain in place and the destination is empty. The move therefore freed 0 bytes. Do not retry with a deletion or copy/delete workaround; use an elevated/native file operation outside this task if the user wants these profiles moved later.

Project source, payment archives, project memory, audit reports, deliverables, backups, and release artifacts were not targeted.

Additional cleanup completed by the implementation owner: npm cache cleaning reclaimed approximately 122 MB; four empty `C:\tmp\mapping-ui-edge*` profiles were moved to `D:\CodexClipflowBuild\recovered-temp` (approximately 61 MB); and an abandoned frontend `node_modules` directory was moved to `D:\CodexClipflowBuild\abandoned-node-modules` (approximately 11 MB). The `C:\idh` profiles above remain in place because the operating system denied the recoverable move.

Follow-up verification: the nine `C:\idh` profiles were subsequently moved successfully by the implementation owner to `D:\CodexClipflowBuild\recovered-idh-temp`. All nine source paths are absent, all nine destination directories are present, and the measured preserved total is 770,174,618 bytes (734.5 MiB). No deletion was used.

## Storage cleanup

Removed regenerable package caches with npm/pip cache commands and 67 hashed Chromium component-cache packages from three inactive audit profiles under C:\idh. App code, settings, source videos, projects, exports, installed runtimes, and model files were retained.

- C: npm download cache: approximately 497 MB.
- D: npm download cache: approximately 160 MB.
- C: pip download/wheel cache: approximately 94 MB (588 files).
- C:\idh browser component packages: 108,319,194 bytes.
- Total cache contents removed: approximately 859 MB. Final free space: C: 699 MB; D: 159 MB; E: 865 MB. Other processes may change these figures.
- Clipflow health endpoint returned HTTP 200 after cleanup.

Automatic approval review rejected the broader workspace deletion and deletion of D:\CodexClipflowBuild\recovered-idh-temp, reporting only "blocked by policy". Those rejected deletions were not executed. The approximately 770 MB archive of recovered temporary profiles remains. Mixed source trees under C:\idh\.tmp and C:\idh\tmp were preserved.

## Rebuild storage pass — 2026-09-20

Applied non-destructive NTFS compression to the preserved recovered-idh-temp archive: 770,174,618 logical bytes occupy 522,732,075 bytes, about 247 MB less allocated storage. No recovered profiles or user media were deleted. Free disk remains limited; do not download larger speech models without more room.
