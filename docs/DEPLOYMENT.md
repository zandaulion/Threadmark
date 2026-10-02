# Deployment and operations

Threadmark supports direct Node processes for development, Podman Compose, and rootless Podman Quadlet for a persistent personal server. Node 24 or later is required by the built-in SQLite API.

## Prerequisites

- Node.js 24+
- npm
- Podman for container deployment
- systemd user services for Quadlet deployment
- an HTTPS origin reachable only by intended users
- Tailscale or another private reverse proxy is strongly recommended

The bridge image builds Tesseract, Poppler, FFmpeg and whisper.cpp support. The build therefore needs registry and source-network access and can take several minutes on the first run.

## Configuration

Create a mode-`0600` environment file outside Git:

```bash
node scripts/create-env.mjs https://threadmark.example
```

By default this writes `~/.config/threadmark/server.env` and refuses to overwrite an existing file. Set `THREADMARK_ENV_FILE` to choose another destination.

| Variable | Purpose | Default/source |
| --- | --- | --- |
| `PUBLIC_BASE_URL` | Exact external HTTPS origin used in invitation URLs | required by generator |
| `COOKIE_SECURE` | Require Secure device cookies | `1`; use `0` only for localhost development |
| `ADMIN_TOKEN` | Private invitation/device API credential | random 32-byte hex |
| `BRIDGE_TOKEN` | App-to-bridge and bridge-to-app credential | random 32-byte hex |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Web Push signing keys | generated |
| `VAPID_SUBJECT` | VAPID administrator contact | placeholder email; update it |
| `RETENTION_DAYS` | Retention for non-open matched messages | `30` |
| `JEV_ENABLED` | Enable Jev when an API key is present | `0` from generator |
| `TYPESAFE_API_KEY` | TypeSafe AI credential | empty |
| `JEV_MODEL` | TypeSafe model name | `jev-latest` |
| `JEV_THRESHOLD` | Built-in semantic threshold | `0.78` |
| `JEV_TIMEOUT_MS` | Maximum Jev request time | `4500` |

Runtime-only variables include `HOST`, `PORT`, `DATA_DIR`, `BRIDGE_CONTROL_URL` for the app and `APP_INTERNAL_URL` for the bridge. Container definitions set these correctly.

## Direct development run

Install and test:

```bash
npm --prefix app ci
npm --prefix bridge ci
npm test
```

For localhost, create a temporary environment file in the repository and change `COOKIE_SECURE=0`. Start the app:

```bash
set -a
. deploy/threadmark.env
set +a
DATA_DIR="$PWD/data/app" HOST=127.0.0.1 node app/server/index.mjs
```

In another terminal start the bridge:

```bash
set -a
. deploy/threadmark.env
set +a
DATA_DIR="$PWD/data/bridge" HOST=127.0.0.1 node bridge/index.mjs
```

The app listens on port `4391`; the bridge control endpoint listens on `4392`.

## Podman Compose

With an environment file at `deploy/threadmark.env`:

```bash
podman compose up --build -d
curl -fsS http://127.0.0.1:4391/api/health
```

Override locations when desired:

```bash
THREADMARK_ENV_FILE=/secure/threadmark.env \
THREADMARK_DATA_DIR=/srv/threadmark \
podman compose up --build -d
```

The app port is published on loopback. The bridge is reachable only over the `threadmark` container network.

## Rootless Quadlet production deployment

After generating `~/.config/threadmark/server.env`, run:

```bash
./deploy.sh
```

The script installs pinned dependencies, runs tests, builds both images, installs the Quadlet files, starts the app, checks health and then starts the bridge. Persistent data is placed under:

```text
~/.local/share/threadmark/app
~/.local/share/threadmark/bridge
```

Enable lingering if the user services must run before login:

```bash
loginctl enable-linger "$USER"
```

Inspect services:

```bash
systemctl --user status threadmark-app.service threadmark-bridge.service
journalctl --user -u threadmark-app.service -u threadmark-bridge.service -f
```

## Private HTTPS exposure

For Tailscale Serve on a dedicated port:

```bash
tailscale serve --bg --https=8444 http://127.0.0.1:4391
```

Set `PUBLIC_BASE_URL` to that exact HTTPS origin, including the non-default port. A dedicated origin or port prevents service-worker scope from colliding with another PWA.

If using Caddy, nginx or another proxy:

- forward the full app origin to `127.0.0.1:4391`;
- preserve streaming for `/api/stream` and avoid response buffering;
- never inject `ADMIN_TOKEN` into the public route;
- do not expose bridge port `4392`;
- keep HTTPS and `COOKIE_SECURE=1` in production.

## Invitation console integration

Threadmark implements the invitation/device contract used by `pwa-invite-console`. The supplied installer can add a private Caddy API route and app entry:

```bash
sudo python3 scripts/install-console-route.py
```

Defaults are `/etc/caddy/Caddyfile`, `/var/www/pwa-invite-console/apps.json`, `/threadmark/api/*` and backend `127.0.0.1:4391`. Override them with `THREADMARK_CADDYFILE`, `THREADMARK_CONSOLE_APPS`, `THREADMARK_CONSOLE_ANCHOR` and `THREADMARK_ENV_FILE`.

Only the private console route may inject `X-Admin-Token`.

## Configure Jev

Use the non-echoing helper:

```bash
node scripts/configure-jev.mjs
systemctl --user restart threadmark-app.service
```

It reads the key through `systemd-ask-password`, updates only the protected environment file and does not print the secret. Disable calls while retaining the key with:

```bash
node scripts/configure-jev.mjs --disable
systemctl --user restart threadmark-app.service
```

## Health and routine operations

App health:

```bash
curl -fsS http://127.0.0.1:4391/api/health
```

Container state:

```bash
podman ps --filter name=threadmark
podman logs --tail 100 threadmark-app
podman logs --tail 100 threadmark-bridge
```

The app performs due-notification checks, digest checks and retention pruning every minute. The bridge reconnects after ordinary disconnects and retains undelivered normalized events in its SQLite outbox.

## Upgrade

1. Back up data and the environment file.
2. Review application and dependency changes.
3. Run `npm test`.
4. Run `./deploy.sh` to rebuild and restart.
5. Verify `/api/health`, both services and the PWA version.
6. If a browser remains stale, open `/bust` on that Threadmark origin.

SQLite schema migrations are applied on application startup. Keep the pre-upgrade backup until the new version is verified.

## Backup and restore

Back up these as one encrypted set:

- app data directory, including `threadmark.sqlite` and its WAL files;
- bridge data directory, including `auth/` and `outbox.sqlite`;
- `server.env`.

For a consistent simple backup, stop both services first:

```bash
systemctl --user stop threadmark-bridge.service threadmark-app.service
```

Copy the three locations to encrypted storage, then restart app before bridge:

```bash
systemctl --user start threadmark-app.service threadmark-bridge.service
```

To restore, stop both services, replace all three locations with the matching backup, confirm ownership and mode `0600` for the environment file, then start app followed by bridge. Treat every backup as a WhatsApp account credential because it includes linked-device keys.

## Troubleshooting

**App health fails**

- Inspect `threadmark-app` logs.
- Confirm the data directory is writable and the environment file is readable.
- Check that port `4391` is free.

**Bridge stays offline**

- Inspect bridge logs and open the Connect dialog.
- Check `BRIDGE_TOKEN` is identical for both containers.
- Confirm the app is healthy and resolvable as `threadmark-app:4391` on the container network.
- Pair again if WhatsApp explicitly logged out the linked device.

**Jev says not configured**

- Ensure `JEV_ENABLED=1` and `TYPESAFE_API_KEY` is non-empty.
- Restart the app after changing the environment file.
- Verify outbound network/DNS access from the app container.

**Push is unavailable**

- Verify all three VAPID settings.
- Verify HTTPS and `COOKIE_SECURE=1`.
- Check browser/OS permission and open the installed PWA once.

**Media extraction fails**

- Confirm attachment reading is enabled.
- Inspect bridge logs for timeout or unsupported-type messages.
- The hard attachment limit is 20 MiB; videos are described but not transcribed.
