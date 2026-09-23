# Hosted owner workspace

Clipflow keeps local mode account-free. Hosted mode is an intentionally small deployment adapter for one owner workspace: one persistent FastAPI worker, one data directory, and one Supabase Auth owner. It is not a shared multi-user datastore. A future multi-user release needs isolated worker/data deployments or an explicit tenant migration before enabling more than one owner.

## Required hosted settings

Set these variables on the persistent worker:

```text
CLIPFLOW_MODE=hosted
CLIPFLOW_PUBLIC_ORIGIN=https://studio.example.com
CLIPFLOW_WORKER_ORIGIN=https://worker.example.com
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
CLIPFLOW_OWNER_ID=<the Supabase auth user id>
```

`CLIPFLOW_PUBLIC_ORIGIN` must be HTTPS and is compared exactly against the browser `Origin`. Hosted startup fails closed if it is missing, uses HTTP, contains a path/query, or if the Supabase URL, publishable key, or owner ID is absent. `SUPABASE_ANON_KEY` is accepted as a compatibility alias. Provider secrets stay on the worker and are never returned by the auth endpoints.

`CLIPFLOW_WORKER_ORIGIN` is the direct HTTPS address of this persistent worker. It is required for the optional desktop-assisted YouTube import link; when absent, only that handoff returns 503. Put it in the worker's `.env` and pass it through the container environment. The desktop package trusts only configured worker and website origins, so self-hosted deployments must also configure `CLIPFLOW_TRUSTED_WORKER_ORIGINS` and `CLIPFLOW_TRUSTED_WEB_ORIGINS` on the desktop machine.

When the hosted YouTube request is blocked, an authenticated owner can create a short-lived desktop ticket. The worker stores only its hash in the data volume. The installed Windows app handles `clipflow://`, validates the worker's HTTPS origin, downloads on the user's connection, and uploads the MP4 directly to the worker with that ticket in an Authorization header. The worker accepts that bearer token only on the exact ticket lookup and upload paths; the successful upload consumes it. The existing 500 MB source limit and project import checks still apply. This route does not depend on a third-party downloader or expose the owner session cookie to the desktop process.

The adapter uses a server-side opaque `clipflow_session` cookie. The raw token is only sent in the Secure, HttpOnly, SameSite=Lax cookie; the worker stores a SHA-256 digest with an expiry. Sessions are intentionally in memory, so a worker restart signs the owner out. Login is verified with Supabase's REST `POST /auth/v1/token?grant_type=password` endpoint, whose response includes a user object and access token in the [official Auth API](https://supabase.com/docs/reference/self-hosting-auth), then the returned user ID must exactly equal `CLIPFLOW_OWNER_ID`. Five attempts per socket peer per minute are allowed, with an additional process-wide cap; spoofable `X-Forwarded-For` headers are not used for authorization or as the only limiter key. Passwords are never logged.

## Root integration

The root FastAPI app calls `install_hosted_security(app)` during construction, after the FastAPI object exists and before serving requests. It installs `/api/auth/session`, `/api/auth/login`, and `/api/auth/logout` plus a gate covering every `/api/*` and `/media/*` request. In local mode it adds a harmless `/api/auth/session` mode probe and no login dependency. In hosted mode, anonymous `GET /api/health` is intercepted to a minimal `{ "ready": true }`; an authenticated owner request may continue to the existing full capability response. API docs (`/docs`, `/redoc`, `/openapi.json`) are owner-only. API, auth, media, and docs responses receive `Cache-Control: no-store`.

The existing app's CORS middleware uses the same single `CLIPFLOW_PUBLIC_ORIGIN` in hosted mode. The hosted middleware independently rejects missing or foreign `Origin` headers on every mutation, including login, logout, uploads, settings, job creation, edits, and deletes. Routes that need the identity can use `require_hosted_owner` as a FastAPI dependency. Call `install_hosted_security(app)` in both modes: local mode remains account-free while exposing only the harmless `/api/auth/session` mode probe; hosted mode adds the owner gate and auth routes.

On the Vite side, `main.tsx` wraps `<App />` with `<HostedGate>`. The gate probes `/api/auth/session` at runtime: the local mode response mounts the editor without an account, the hosted response mounts the owner login or editor, and a network/5xx failure shows worker unavailable instead of pretending the user is signed out. `VITE_CLIPFLOW_MODE=hosted` can force hosted behavior for a deployment and catches a missing hosted auth route. The gate exposes `useHostedAuth().logout()` and includes a small sign-out control while hosted. Do not put Supabase or provider secrets in Vite variables.

## Same-origin Vercel proxy

The browser should call relative `/api/...` and `/media/...` URLs. Configure the Vercel project to proxy both prefixes to the persistent worker origin over HTTPS, with the worker origin stored as deployment configuration rather than committed source. Large multipart uploads through the external rewrite remain unverified on a live deployment; a serverless function proxy must not be used for source uploads because normal Vercel request body limits are far below Clipflow's local 500 MiB limit. The proxy must preserve `Cookie`, `Content-Type`, `Origin`, and response `Set-Cookie` headers.

For a generated rewrite file, set the worker origin in the deployment environment and run `CLIPFLOW_WORKER_ORIGIN=https://worker.example.com node scripts/generate-vercel-config.mjs` before `vercel deploy`. Run from the repository root and keep the Vercel root directory at the repository root: the generated file includes the frontend install/build commands and `frontend/dist` output directory. If the Vercel project root directory is `frontend`, generate its tracked project config with `CLIPFLOW_WORKER_ORIGIN=https://worker.example.com node scripts/generate-vercel-config.mjs --output frontend/vercel.json`; that variant uses `npm ci`, `npm run build`, and `dist`. Set `VITE_CLIPFLOW_MODE=hosted` on the frontend deployment. The repository-root generated file is ignored by Git; `frontend/vercel.json` is intentionally allowed for a Vercel project whose root is `frontend`. The current tracked frontend configuration points at the live Azure worker; generate a new file when changing worker hosts. The script rejects missing, HTTP, localhost, loopback, credential-bearing, or path-qualified origins; it never emits a localhost fallback.

The external worker origin must be HTTPS and must not be localhost or a loopback address. Keep the Vercel frontend and worker on the same public origin from the browser's point of view; this lets the Secure HttpOnly cookie accompany API and media requests without exposing it to JavaScript. If a rewrite is generated from an environment variable, fail the deployment script when the variable is absent or not HTTPS rather than falling back to localhost.

The worker needs persistent storage for `CLIPFLOW_DATA`, enough temporary disk for uploads/renders, FFmpeg/FFprobe, and a long request/job lifetime. Run one worker for the current in-process executor. Do not deploy the processing worker as an ephemeral serverless function: jobs, media, and the in-memory session store must share the same persistent instance.

The container listens on `PORT` when a host supplies it and uses `8767` otherwise. Set `CLIPFLOW_MODEL_CACHE=/app/data/models` (the Docker image default) so local Whisper downloads stay on the persistent data volume. The Docker build context excludes generated desktop artifacts, local data, tests, docs, dependency caches, archives, `.env` files, and the private Neue font binaries; provider secrets and user media must be supplied through the host environment or volume only.

For Azure container hosting, configure ingress to the container port (`8767` by default, or the value supplied through `PORT`) and mount persistent storage at `CLIPFLOW_DATA`. The default container filesystem is not a safe home for projects, source media, exports, settings, or downloaded speech models.

### Azure VM source deploy

The repository includes an Ubuntu 24.04 cloud-init bootstrap at `deploy/azure/cloud-init.yaml` and a Caddy-fronted Compose file at `deploy/azure/compose.yaml`. They expect the source tree at `/opt/clipflow`, keep the API on the internal Docker network, expose only Caddy on ports 80 and 443, and persist `/app/data` plus `/app/data/models` in named volumes. Copy `deploy/azure/hosted.env.example` to `/opt/clipflow/.env`, set the domain and hosted Supabase values, then run:

```bash
cd /opt/clipflow
docker compose --env-file /opt/clipflow/.env -f /opt/clipflow/deploy/azure/compose.yaml up -d --build --remove-orphans
```

The cloud-init script installs Docker Engine and Compose from Docker's Ubuntu repository. If `/opt/clipflow` or its hosted environment file is not present yet, bootstrap completes with Docker ready and prints the follow-up command; otherwise it starts the stack immediately. It never creates Azure resources or embeds credentials.

If the VM holds a source copy rather than a Git checkout, `deploy/azure/update-source.sh` updates it from an exact 40-character commit SHA. The script preserves `/opt/clipflow/.env`, `build/` (including the desktop ZIP), and the named Docker volumes. It sets `CLIPFLOW_WORKER_ORIGIN` in `.env`, builds the worker, and waits for HTTPS health. Run it as root with the revision and direct worker HTTPS origin as arguments.

## Verification

`backend/tests/test_hosting.py` uses a fake Supabase client and covers fail-closed configuration, local no-account mode, owner login, Secure/HttpOnly opaque cookies, non-owner rejection, exact-origin mutation checks, media/API protection, logout revocation, rate limiting, and session expiry. It does not contact a live Supabase account; perform one manual smoke test after the worker and Supabase owner are configured.
