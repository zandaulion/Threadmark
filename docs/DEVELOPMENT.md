# Development guide

## Repository map

```text
app/server/       HTTP API, auth, SQLite store, detectors, rules, Jev and push
app/web/          dependency-free PWA, styles, service worker and icons
bridge/           Baileys connector, normalization, media pipeline and outbox
gmail/            Gmail OAuth, incremental sync, MIME normalization and outbox
deploy/           container images and rootless Quadlet units
scripts/          environment, Jev, console, browser and portfolio utilities
test/             Node test suite
docs/             user, architecture, deployment, privacy and API guides
```

The root package owns tests and developer utilities. `app/`, `bridge/` and `gmail/` have separate pinned production manifests so their container images remain isolated.

## Install and verify

Node 24+ is required.

```bash
npm --prefix app ci
npm --prefix bridge ci
npm --prefix gmail ci
npm test
```

Run an individual suite while developing:

```bash
node --test test/detectors.test.mjs
node --test test/server.test.mjs
```

The server tests bind ephemeral localhost ports. Environments that sandbox network binding must allow loopback listening.

Before a release also build all three container images and check `/api/health` in a clean deployment.

## Design rules

- Reject unselected content before detection, Jev or durable message storage.
- Keep connector normalization independent from UI/detector concepts.
- Use stable message IDs and idempotent outbox delivery.
- Run cheap local detection before external semantic detection.
- Never log message bodies or secrets.
- Treat media as temporary and enforce byte/time limits.
- Return one stable attention-item shape from every detector.
- Broadcast mutations over SSE so all open PWAs converge.
- Preserve usable behavior when Jev, push or the bridge is temporarily unavailable.

## Add a local detector

1. Add focused extraction/matching code under `app/server/`.
2. Return the detection contract documented in [Architecture](ARCHITECTURE.md).
3. Compose it in `detectAttention` or another explicit pipeline stage.
4. Include Romanian/English, positive, negative and malformed-input tests.
5. Confirm it does not cause locally matched text to be sent to Jev unless it participates in a documented semantic verification step such as Gmail meeting confirmation.
6. Add the category or UI metadata only if the existing payment/meeting/reminder taxonomy is insufficient.

Detection keys must be stable per message so generated item IDs remain deterministic.

## Add a semantic capability

The TypeSafe adapter is `app/server/jev.mjs`. Model each judgment as a small typed question with explicit true/false guidance. Keep product policy in ordinary code: thresholds, precedence, sorting and state changes should be visible and testable rather than buried in prompt prose.

When adding a signal:

- state exactly which messages are eligible;
- decide whether it expands the documented privacy boundary;
- bound the input length and timeout;
- keep local ingestion working on failure;
- store the probability separately from the user-facing decision;
- test low/high probability behavior with a fake client, not the live service.

Semantic monitors are user-created rule records and should remain narrower than generic chat summarization.

## Add a connector

Produce the normalized event described in [Architecture](ARCHITECTURE.md), plus group/contact metadata. Deliver through the internal token-authenticated endpoints with a durable retry queue. A connector should not need to know how Threadmark renders, stores or classifies an item.

Required connector properties:

- stable event IDs;
- explicit connector-neutral source identity;
- incoming/outgoing direction;
- source discovery without storing unselected message content in the app;
- metadata-first routing when the upstream API permits it;
- retry without duplicate items;
- no message sending unless a future product requirement explicitly introduces it.

## PWA changes

The frontend uses plain HTML, CSS and JavaScript. Keep interaction accessible:

- native dialog semantics and labelled controls;
- keyboard-visible focus;
- no horizontal overflow at 390 px;
- touch targets large enough for mobile;
- action menus contained within cards on narrow screens;
- full message text available on request;
- detector source and confidence visible without color alone.

The service worker build token is replaced with a hash of `app/web` when the server starts. API routes must remain network-only.

## Synthetic portfolio screenshots

Generate the checked-in portfolio set with:

```bash
npm run screenshots
```

Optional output directory:

```bash
node scripts/portfolio-screenshots.mjs /tmp/threadmark-portfolio
```

Optional browser paths:

```bash
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
CHROMIUM_EXECUTABLE=/path/to/chromium \
npm run screenshots
```

The runner:

1. creates a temporary application data directory;
2. starts Threadmark on an ephemeral loopback port;
3. injects a local fake Jev adapter, so it makes no TypeSafe request;
4. creates and redeems a disposable invitation;
5. seeds invented groups, contacts, rules and messages through real APIs;
6. captures desktop, tablet and mobile views with the real PWA;
7. checks each viewport for horizontal overflow and browser errors;
8. writes `docs/images/portfolio/manifest.json`;
9. closes the browser/server and deletes the temporary database.

It does not open or modify production data. Keep all fixture names, numbers, account identifiers and message text obviously synthetic.

## Browser smoke test

`scripts/browser-check.mjs` is intended for an already running disposable/test instance. It accepts a base URL, invitation code and bridge token and mutates that instance with synthetic data:

```bash
node scripts/browser-check.mjs BASE_URL INVITE_CODE BRIDGE_TOKEN /tmp/threadmark.png
```

Do not point it at production.

## Release checklist

- `npm test` passes.
- App and connector images build from their lockfiles.
- Health check, WhatsApp reconnect and Gmail checkpoint recovery work.
- New privacy boundaries are documented.
- New settings have safe defaults and persist.
- Mobile, tablet and desktop layouts have no horizontal overflow.
- Push icon, manifest, install and `/bust` recovery work.
- Migrations preserve an older database copy in testing.
- Backups and a rollback point exist before production deployment.
- Portfolio images contain only synthetic data.
