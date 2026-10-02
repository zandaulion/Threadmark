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
| `JEV_INVOICE_THRESHOLD` | Narrow invoice judgment threshold | `0.68` |
| `JEV_TIMEOUT_MS` | Maximum Jev request time | `4500` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth web client | empty until configured |
| `GMAIL_OAUTH_REDIRECT_URI` | Exact authorized callback URI | generated from `PUBLIC_BASE_URL` |
| `GMAIL_TOKEN_ENCRYPTION_KEY` | Encrypt the Gmail refresh token at rest | random 32-byte base64url |
| `GMAIL_POLL_SECONDS` | Incremental Gmail polling interval | `60` |

Runtime-only variables include `HOST`, `PORT`, `DATA_DIR`, connector control URLs for the app and `APP_INTERNAL_URL` for connectors. Container definitions set these correctly.

### Personal Gmail OAuth

In Google Cloud Console, enable Gmail API, configure an External OAuth consent screen, and create a **Web application** OAuth client. Its authorized redirect URI must exactly equal `GMAIL_OAUTH_REDIRECT_URI`. Add your Gmail address as a test user while the consent screen is in Testing, then store the credentials with:

```bash
node scripts/configure-gmail.mjs
```

Testing-mode refresh tokens for personal Gmail normally expire after seven days. Move the consent screen to **In production** for unattended use. Apps distributed to other users may require Google verification because `gmail.readonly` is a restricted scope.

## Direct development run

Install and test:

```bash
npm --prefix app ci
npm --prefix bridge ci
npm --prefix gmail ci
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

Start `gmail/index.mjs` in a third terminal with `DATA_DIR="$PWD/data/gmail" HOST=127.0.0.1`. The app listens on `4391`; WhatsApp and Gmail connector control endpoints use `4392` and `4393`.

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

The app port is published on loopback. Both connectors are reachable only over the `threadmark` container network.

## Rootless Quadlet production deployment

After generating `~/.config/threadmark/server.env`, run:

```bash
./deploy.sh
```

The script installs pinned dependencies, runs tests, builds all three images, installs the Quadlet files, starts the app, checks health and then starts both connectors. Persistent data is placed under:

```text
~/.local/share/threadmark/app
~/.local/share/threadmark/bridge
~/.local/share/threadmark/gmail
```

Enable lingering if the user services must run before login:

```bash
loginctl enable-linger "$USER"
```

Inspect services:

```bash
systemctl --user status threadmark-app.service threadmark-bridge.service threadmark-gmail.service
journalctl --user -u threadmark-app.service -u threadmark-bridge.service -u threadmark-gmail.service -f
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
- do not expose connector ports `4392` or `4393`;
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
podman logs --tail 100 threadmark-gmail
```

The app performs due-notification checks, digest checks and retention pruning every minute. Connectors retain undelivered normalized events in their SQLite outboxes. Gmail performs metadata-first incremental synchronization at the configured interval.

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
- Gmail data directory, including encrypted OAuth state and `outbox.sqlite`;
- `server.env`.

For a consistent simple backup, stop all services first:

```bash
systemctl --user stop threadmark-bridge.service threadmark-gmail.service threadmark-app.service
```

Copy all locations to encrypted storage, then restart app before connectors:

```bash
systemctl --user start threadmark-app.service threadmark-bridge.service threadmark-gmail.service
```

To restore, stop all services, replace every location with the matching backup, confirm ownership and mode `0600` for the environment file, then start the app followed by connectors. Treat every backup as both a WhatsApp and read-only Gmail account credential.

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

**Gmail will not connect or stops after seven days**

- Confirm Gmail API is enabled and the authorized redirect URI exactly matches the Threadmark callback.
- Confirm the Gmail address is an OAuth test user.
- For persistent monitoring, change the OAuth consent screen from Testing to In production.
- Inspect `threadmark-gmail` logs and reconnect if Google revoked or expired the token.

**Push is unavailable**

- Verify all three VAPID settings.
- Verify HTTPS and `COOKIE_SECURE=1`.
- Check browser/OS permission and open the installed PWA once.

**Counters remain stale after returning to the PWA**

- Confirm the app container is healthy and `/api/summary` is reachable from the device.
- Close and reopen an already-running PWA once after upgrading so it loads the foreground-reconciliation release.
- If the old shell remains installed, open `/bust` once to unregister stale service workers and clear Threadmark caches, then reopen the app.
- Check the browser console for failed `/api/summary`, `/api/feed` or `/api/stream` requests.

**Media extraction fails**

- Confirm attachment reading is enabled.
- Inspect bridge logs for timeout or unsupported-type messages.
- The hard attachment limit is 20 MiB; videos are described but not transcribed.
