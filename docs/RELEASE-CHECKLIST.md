# Release checklist

Use this checklist before presenting a new build or hosted revision. Mark an item only after observing it against the revision being released.

## Source and build

- [ ] `python -m compileall backend launch.py`
- [ ] `Push-Location frontend; npm ci; npm run build; npm test; Pop-Location`
- [ ] `python -m pytest -q` passes, with warnings recorded separately.
- [ ] `.env`, provider credentials, user media, generated exports, model caches, and private fonts are absent from the release archive; only the documented Small model is included.
- [ ] `desktop/verify_bundle.py` passes before the ZIP is created.
- [ ] The extracted desktop package passes `Clipflow.exe --self-test` and retains its FFmpeg license notice.

## Local workflow

- [ ] Import a local video, create a project, run one clip setup, edit a clip, render a preview, export MP4, and download it.
- [ ] Disconnect the build machine from the network, then run one automatic-caption path from the extracted desktop package and confirm the included Small model loads.
- [ ] Exercise the YouTube inspect/import path with a currently available source and confirm a failed source leaves no stuck job.
- [ ] Check transcript correction, caption positioning, speed/audio edits, crop/follow framing, delete/restore, refresh persistence, and batch ZIP output.

## Hosted owner workspace

- [ ] Confirm Vercel rewrites `/api` and `/media` to the HTTPS worker and preserves cookies, `Origin`, content type, and `Set-Cookie`.
- [ ] Sign in as the configured Supabase owner, refresh, sign out, and verify an unauthenticated session cannot read projects or media.
- [ ] Upload a representative source through the hosted frontend; verify a long render, MP4 download, and media range all work through the proxy.
- [ ] Restart the worker and confirm persistent projects/media remain available, while documenting the expected in-memory session sign-out and interrupted jobs.
- [ ] Check free disk, model-cache space, Docker health, Caddy certificate renewal, and log rotation on the worker.
- [ ] Confirm no paid provider is enabled unless its credentials and account limits are intentionally supplied.

## Distribution and handoff

- [ ] Record the exact commit, frontend URL, worker revision, test counts, and unresolved limitations in `docs/VALIDATION.md`.
- [ ] Keep deployment secrets in the host/Vercel/Supabase configuration only; do not add them to README, examples, ZIPs, or Git history.
