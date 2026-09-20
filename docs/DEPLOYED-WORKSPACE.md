# Hosted workspace

The owner workspace is deployed at https://clipflow-aminemons.vercel.app.

Vercel builds `frontend/` from the private GitHub repository. Its external
rewrites send `/api/*` and `/media/*` to the Azure worker over HTTPS. The
worker runs the same FastAPI, FFmpeg, OpenCV and Whisper code as local mode.
Supabase provides owner sign-in; media and jobs remain on the worker.

## Server

- Resource group: `clipflow-production`
- VM: `clipflow-worker`, Sweden Central, Ubuntu 24.04
- Size: `Standard_B2als_v2`, 2 vCPU, 4 GB RAM
- Disk: 64 GB Standard SSD
- Worker: `https://clipflow-aminemons.swedencentral.cloudapp.azure.com`
- Source and private environment file: `/opt/clipflow`
- Compose file: `deploy/azure/compose.yaml`

Caddy manages the HTTPS certificate. Only ports 80 and 443 are public; SSH
is restricted to the deployment computer's public IP. The application port
8767 is internal to Docker. Update the SSH rule if your public IP changes.

The Azure for Students spending limit remains enabled. The VM consumes the
student credit: the checked Linux compute price was $0.0389/hour, about
$28.40 for 730 hours, before disk, public IP and bandwidth. This is not an
indefinitely free hosting plan. Monitor the credit in Azure Education.

## Updating

Copy a reviewed source archive into `/opt/clipflow`, preserving `.env`.
Run these commands on the server:

```sh
cd /opt/clipflow
sudo docker compose --env-file .env -f deploy/azure/compose.yaml up -d --build
sudo docker compose --env-file .env -f deploy/azure/compose.yaml ps
sudo docker compose --env-file .env -f deploy/azure/compose.yaml logs --tail=100 clipflow
```

Provider keys belong in the app's Settings page or the private server
environment, never Vercel frontend variables. The public frontend requires
only `VITE_CLIPFLOW_MODE=hosted`; its worker origin is in `frontend/vercel.json`.

Projects, uploads, exports and saved settings use `azure_clipflow-data`.
Whisper models use `azure_clipflow-models`. These Docker volumes survive
container replacement and VM restarts. They are not a backup: export or
back up the volumes before deleting the VM, disk, or resource group. Never
run `docker compose down -v` against this workspace.

Upload the Windows release to
`/opt/clipflow/build/desktop/Clipflow-windows-x64.zip`. Compose mounts that
directory read-only. Downloads require the same owner login as the API.

The current service is one owner's workspace, not a multi-tenant product.
Restarting the worker ends login sessions and interrupts active jobs, so
wait for jobs to finish before updating. Local and desktop modes remain
account-free.

## Checks

The deployment was checked for HTTPS, proxy routing, successful Supabase
owner login, authenticated project listing, anonymous API/media rejection,
and foreign-origin mutation rejection. The small multilingual Whisper
model was downloaded into persistent storage and loaded on CPU.

In the deployed browser, the sample was imported, automatically clipped,
renamed, trimmed from 12 to 8 seconds, saved, rendered at 720 × 1280,
played, exported and downloaded. A separate process inside the production
container transcribed a speech fixture into four timestamped segments and
rendered a captioned 360 × 640 H.264/AAC clip. This checks execution, not
recognition accuracy on every language or dialect.

The Windows ZIP passed archive integrity and credential/user-data checks;
its uploaded SHA-256 matches the local release:
`a89e5196c42aabf31f9d18457c8502e7713118b63b5c45343ec24df699f3409b`.

Large multipart upload verification remains separate from these checks.
The browser extension must allow file URLs before automated local-file
selection can run. The 500 MB limit has not been tested through Vercel.
