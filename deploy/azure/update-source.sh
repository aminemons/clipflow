#!/usr/bin/env bash
# Update a source-copy deployment without touching its secrets, media, or release ZIP.
set -Eeuo pipefail

revision="${1:-}"
worker_origin="${2:-}"
app=/opt/clipflow

[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || { echo "Pass a full commit SHA." >&2; exit 2; }
[[ "$worker_origin" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || {
  echo "Pass the worker's HTTPS origin without a path." >&2
  exit 2
}
[[ -s "$app/.env" ]] || { echo "Missing $app/.env" >&2; exit 2; }

stage=$(mktemp -d /tmp/clipflow-update.XXXXXX)
env_temp=""
cleanup() {
  [[ -z "$env_temp" ]] || rm -f -- "$env_temp"
  rm -rf -- "$stage"
}
trap cleanup EXIT

mkdir "$stage/source"
curl --fail --location --silent --show-error --retry 2 --max-time 120 \
  "https://codeload.github.com/aminemons/clipflow/tar.gz/$revision" \
  -o "$stage/source.tar.gz"
tar -xzf "$stage/source.tar.gz" -C "$stage/source" --strip-components=1
[[ -s "$stage/source/backend/desktop_import.py" ]] || {
  echo "The requested revision lacks desktop import support." >&2
  exit 1
}

# The server keeps private configuration and desktop releases outside the source update.
rsync -a --exclude=.env --exclude=build/ "$stage/source/" "$app/"
env_temp=$(mktemp "$app/.env.XXXXXX")
awk -v origin="$worker_origin" '
  BEGIN { found = 0 }
  /^CLIPFLOW_WORKER_ORIGIN=/ {
    if (!found) print "CLIPFLOW_WORKER_ORIGIN=" origin
    found = 1
    next
  }
  { print }
  END { if (!found) print "CLIPFLOW_WORKER_ORIGIN=" origin }
' "$app/.env" > "$env_temp"
chown --reference="$app/.env" "$env_temp"
chmod --reference="$app/.env" "$env_temp"
mv -f -- "$env_temp" "$app/.env"
env_temp=""

cd "$app"
docker compose --env-file .env -f deploy/azure/compose.yaml config --quiet
docker compose --env-file .env -f deploy/azure/compose.yaml \
  up -d --build --no-deps --force-recreate clipflow
docker compose --env-file .env -f deploy/azure/compose.yaml \
  exec -T clipflow python -c 'import backend.desktop_import'

for _ in $(seq 1 30); do
  if curl --fail --silent --show-error "$worker_origin/api/health" >/dev/null; then
    echo "Clipflow worker healthy at $revision"
    exit 0
  fi
  sleep 2
done

docker compose --env-file .env -f deploy/azure/compose.yaml logs --tail=80 clipflow >&2
echo "Worker health check failed." >&2
exit 1
