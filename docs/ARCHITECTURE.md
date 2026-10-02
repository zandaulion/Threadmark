# Architecture

Threadmark separates WhatsApp/Gmail access, attention detection and the browser interface into small replaceable components. Connectors are deliberately independent from the PWA and detector logic, and both emit the same normalized event format.

## Components

| Component | Responsibility | Persistent data |
| --- | --- | --- |
| `threadmark-bridge` | WhatsApp linked-device connection, source discovery, local media extraction and durable event delivery | Baileys session credentials and the SQLite outbox |
| `threadmark-gmail` | Read-only Gmail OAuth, incremental history polling, source discovery and durable event delivery | Encrypted OAuth state and the SQLite outbox |
| `threadmark-app` | Invitation auth, source selection, detection, rules, item workflow, API, SSE, push and PWA assets | SQLite application database |
| Browser PWA | Inbox, configuration, installable shell, service worker and push subscription | Revocable session cookie, PWA cache and browser push subscription |
| `pwa-invite-console` | Private creation of invitations and device revocation through Threadmark's admin API | Managed by the external console |
| TypeSafe AI / Jev | Optional typed semantic judgments and probabilities | External service; only invoked within the documented boundary |

The default Podman deployment puts the app and both connectors on one network. Connectors have no host ports. The app binds only to `127.0.0.1:4391`; a private HTTPS reverse proxy or Tailscale Serve provides browser access.

## Message flow

1. Baileys receives a new WhatsApp event with full-history synchronization disabled.
2. The bridge normalizes it into a connector-neutral event.
3. The bridge checks its cached routing configuration. Selected attachments can be processed locally before delivery.
4. The durable outbox posts the event to the app using `BRIDGE_TOKEN`. Failed deliveries stay queued.
5. The app verifies that the source exists and is explicitly selected. Unselected content is rejected before detection or long-term storage.
6. Deterministic invoice, payment and meeting detectors plus enabled local phrase rules run first.
7. If nothing matches, optional Jev built-ins and applicable semantic monitors evaluate the message. The narrow invoice judgment has its own threshold and maps to a Payment item. A local Gmail meeting candidate also goes to Jev for confirmation. Context/reply settings can explicitly request additional Jev signals.
8. A contact image that still has no match can become a local **Photo needs review** item.
9. Only matched messages and attention items are stored. The server broadcasts changes through SSE and optionally sends Web Push.
10. The browser renders the current filtered feed and applies actions through authenticated APIs. Because mobile browsers suspend live streams in the background, visibility, focus and restored-page events trigger a throttled feed/summary reconciliation and stream reconnection.

Gmail follows the same flow with a privacy-preserving routing stage. Connection stores the current `historyId` and deliberately performs no historical import. Each poll calls `history.list`; if Google reports an expired checkpoint, Threadmark resets to the current profile history without backfilling. New mail is first retrieved as metadata. A complete body is fetched only after a label or sender matches the allowlist. Plain text is preferred, HTML is reduced to text, quoted replies and signatures are removed, and attachments are ignored.

## Normalized connector event

Connectors emit this logical shape:

```js
{
  id,
  sourceId,
  sourceName,
  sourceKind,     // group | contact | gmail_label | gmail_sender
  senderId,
  senderName,
  sentAt,
  text,
  direction,      // "incoming" or "outgoing"
  media,
  externalUrl     // optional validated link to the original
}
```

Legacy group-style fields are accepted internally, but new connectors should produce the explicit source fields. Event IDs must be stable because both the bridge outbox and app database use them for idempotency.

## Detection pipeline

### Local deterministic layer

`app/server/detectors.mjs` recognizes Romanian and English invoice, payment, subscription-lifecycle and meeting signals. Concrete invoice notices can match without an amount or IBAN. Direct-recipient/action wording is sufficient; otherwise utility context, an amount or an IBAN must occur within 160 characters of the invoice term. This prevents unrelated words in long newsletters from being combined into a local match. Informational paid receipts and order confirmations are excluded unless the message also contains an explicit unpaid action or a subscription purchase, start, renewal, price change, expiration, cancellation or payment failure. Clearly labeled test purchase receipts remain excluded. The receipt exclusion also disables Jev's built-in categories for that message, while deliberately configured semantic monitors can still inspect it. The detector extracts amount, normalized currency, IBAN, dates, times and links where possible. `app/server/rules.mjs` evaluates case- and accent-insensitive phrase rules with any/all matching and optional source scope.

This layer is fast, explainable and does not send text off the server.

### Semantic layer

`app/server/jev.mjs` expresses invoice, payment, meeting, reminder, urgency, context and payment-safety questions as TypeSafe units. The invoice Noul asks specifically whether a concrete bill for the recipient has been issued, attached, made available or needs action; it excludes marketing, software features and hypothetical examples. Enabled semantic monitors are added as narrow questions and batched into the same System One request.

Local matches normally prevent a Jev call, including strong invoice matches from either WhatsApp or Gmail. For otherwise-unmatched text, an invoice probability at or above `JEV_INVOICE_THRESHOLD` becomes a Payment item before the generic category scores are considered. Context-aware and reply features are explicit exceptions because they request semantic enrichment even when a local detector matched. Gmail meeting candidates are another narrow exception: Jev must meet the configured meeting threshold before the local item is stored. Confirmed items retain local extraction details and record the Jev model, probability and threshold. API failure or a missing score is fail-open, so ingestion continues and the local meeting is retained.

### Enrichment

Before storage, the app adds locally extracted deadlines and conservative payment safety signals. Jev urgency is stored separately as `priority`; items at or above `0.78` sort first and receive an urgent badge/title. Context signals can mark a prior item done after cancellation or update its deadline after a correction.

All detectors return a stable shape:

```js
{
  type,          // payment | meeting | reminder
  key,
  title,
  confidence,
  priority,
  amountMinor,
  currency,
  eventAt,
  notify,
  details
}
```

## Storage model

The application uses Node's built-in SQLite driver. The main entities are:

- `devices` and `invites` for browser authorization;
- `groups` for all WhatsApp and Gmail sources, distinguished by `kind`, plus their selection state;
- `messages` for matched message excerpts only;
- `attention_items` for category, confidence, priority, status, snooze, feedback and detector details;
- `rules` for local phrases and semantic conditions;
- `context_messages` for the optional 48-hour rolling buffer;
- `push_subscriptions`, `system_state` and `audit_events`.

Open attention items are preserved by retention pruning. Older messages whose items are no longer open are deleted after `RETENTION_DAYS`. Expired context is pruned by the same minute scheduler.

Each connector keeps its own `outbox.sqlite`. WhatsApp multi-file auth state lives in the bridge volume. Gmail OAuth credentials are AES-256-GCM encrypted in the Gmail volume with a key held in the protected environment file. These stores serve different recovery purposes and should be backed up together.

## Authentication and trust boundaries

Browser access is invitation-based. A single-use code creates a random device token; only a hash is stored in SQLite, while the browser receives an HttpOnly, SameSite cookie. Administrators use a separate `ADMIN_TOKEN`. Connector-only endpoints require `BRIDGE_TOKEN` and are not exposed by the public route. The unauthenticated Google callback is limited to a single-use, random, ten-minute OAuth state value because the Strict browser cookie is intentionally absent on a cross-site return.

State-changing requests reject cross-origin browser origins. API responses use `no-store`. Static files reject traversal and hidden paths. Containers drop all Linux capabilities and enable `no-new-privileges`.

The material trust boundaries are:

1. WhatsApp/Baileys to the local bridge;
2. Google OAuth/Gmail API to the local Gmail connector;
3. browser to the HTTPS app origin;
4. optional selected message text from the app to TypeSafe AI.

See [Privacy and security](PRIVACY.md) for the data sent across each boundary.

## Realtime and offline behavior

The browser opens `/api/stream` and listens for item, source, rule, bridge and settings events. If SSE disconnects while the page is visible, the client schedules one retry and replaces the old stream rather than accumulating reconnect timers.

Mobile operating systems commonly suspend an installed PWA and its SSE connection in the background without delivering a clean disconnect. On `visibilitychange`, `pageshow` or window focus, an authenticated foreground page therefore reloads `/api/summary` and its current `/api/feed` view. Returning from a hidden or restored page also replaces the stream. Closely grouped lifecycle events share one in-flight refresh and are throttled for 750 milliseconds.

The service worker caches only the application shell. API and internal routes are network-only and never cached. Static assets are network-first so deployments update promptly; the `/bust` recovery page clears stale cache state.

## Extension points

- **New local detector:** add a module that returns the stable detection shape and compose it in `detectAttention`.
- **New semantic capability:** add typed Jev questions/signals and map probabilities to explicit product behavior.
- **New connector:** emit normalized source/message events and use the authenticated internal API.
- **New item workflow:** add storage methods, an authenticated endpoint and a card action; preserve SSE updates.
- **New attachment type:** extend `bridge/media.mjs`, enforce size/time limits and always remove temporary files.
- **New administrative client:** implement against the documented admin API rather than reading the database.

Keep connectors free of product-specific detection. Keep unselected message rejection ahead of semantic calls and storage.
