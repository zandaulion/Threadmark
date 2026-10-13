#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_ROOT="${XDG_CONFIG_HOME:-${HOME}/.config}"
CONFIG_DIR="${THREADMARK_CONFIG_DIR:-${CONFIG_ROOT}/threadmark}"
QUADLET_DIR="${CONFIG_ROOT}/containers/systemd"

for executable in node npm podman systemctl curl install; do
  command -v "$executable" >/dev/null || { echo "required executable not found: ${executable}" >&2; exit 1; }
done
# Older deployments shared one server.env across every container.
if [[ ! -f "$CONFIG_DIR/app.env" && -f "$CONFIG_DIR/server.env" ]]; then
  THREADMARK_CONFIG_DIR="$CONFIG_DIR" node "$ROOT/scripts/split-env.mjs"
fi
for file in app.env bridge.env gmail.env; do
  [[ -f "$CONFIG_DIR/$file" ]] || { echo "Missing ${CONFIG_DIR}/${file}. Run: node scripts/create-env.mjs https://your-threadmark-origin" >&2; exit 2; }
done
grep -Eq '^ADMIN_TOKEN=[a-f0-9]{64}$' "$CONFIG_DIR/app.env" || { echo "ADMIN_TOKEN is missing or malformed." >&2; exit 2; }
BRIDGE_TOKENS="$(grep -hE '^BRIDGE_TOKEN=[a-f0-9]{64}$' "$CONFIG_DIR/app.env" "$CONFIG_DIR/bridge.env" "$CONFIG_DIR/gmail.env")"
[[ "$(wc -l <<<"$BRIDGE_TOKENS")" == 3 && "$(sort -u <<<"$BRIDGE_TOKENS" | wc -l)" == 1 ]] \
  || { echo "BRIDGE_TOKEN is missing, malformed or differs between the environment files." >&2; exit 2; }

npm --prefix "$ROOT/app" ci --ignore-scripts
npm --prefix "$ROOT/bridge" ci --ignore-scripts
npm --prefix "$ROOT/gmail" ci --ignore-scripts
npm --prefix "$ROOT" test

podman build --tag localhost/threadmark-app:latest --file "$ROOT/deploy/Containerfile.app" "$ROOT"
podman build --tag localhost/threadmark-bridge:latest --file "$ROOT/deploy/Containerfile.bridge" "$ROOT"
podman build --tag localhost/threadmark-gmail:latest --file "$ROOT/deploy/Containerfile.gmail" "$ROOT"

install -d -m 0700 "$HOME/.local/share/threadmark/app" "$HOME/.local/share/threadmark/bridge" "$HOME/.local/share/threadmark/gmail" "$HOME/.local/share/threadmark/gmail-dev"
install -d -m 0755 "$QUADLET_DIR"
for unit in threadmark.network threadmark-app.container threadmark-bridge.container threadmark-gmail.container threadmark-gmail-dev.container; do
  install -m 0644 "$ROOT/deploy/quadlet/${unit}" "$QUADLET_DIR/${unit}"
done
systemctl --user daemon-reload
systemctl --user restart threadmark-app.service
for _ in $(seq 1 30); do
  curl -fsS --max-time 2 http://127.0.0.1:4391/api/health >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS --max-time 2 http://127.0.0.1:4391/api/health >/dev/null
systemctl --user restart threadmark-bridge.service
systemctl --user restart threadmark-gmail.service
systemctl --user restart threadmark-gmail-dev.service
echo 'Threadmark deployed. The app is listening on 127.0.0.1:4391.'
