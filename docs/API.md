# API reference

All JSON responses use `Cache-Control: no-store`. Browser state-changing requests are same-origin only. Paths below are relative to the Threadmark app origin.

This is a private application API, not a versioned public contract. The invitation-console endpoints and normalized bridge event shape are the intended integration points.

## Authentication

Browser APIs use the HttpOnly `threadmark_device` session cookie issued after invitation redemption.

Administrator APIs require:

```http
X-Admin-Token: <ADMIN_TOKEN>
```

Internal bridge APIs require:

```http
X-Bridge-Token: <BRIDGE_TOKEN>
```

Unauthorized admin/internal requests intentionally return `404` to avoid exposing those surfaces.

## Health and browser authentication

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Process health and last known bridge status; no auth |
| `GET` | `/api/auth/session` | Current device session state |
| `POST` | `/api/auth/redeem` | Redeem `{code, label}` and set device cookie |
| `POST` | `/api/auth/logout` | Clear the browser cookie |

## Administrator API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/admin/devices` | List registered devices |
| `GET` | `/api/admin/invites` | List invitations |
| `POST` | `/api/admin/invites` | Create an invite with `{label}` |
| `POST` | `/api/admin/invites/:id/revoke` | Revoke an invitation |
| `POST` | `/api/admin/devices/:id/revoke` | Set `{revoked}` |
| `POST` | `/api/admin/devices/:id/label` | Set `{label}` |
| `DELETE` | `/api/admin/devices/:id` | Delete a device and its push subscriptions |

The create response includes the one-time code and URL. Never expose the admin token in the main PWA proxy route.

## Inbox and preferences

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/summary` | Open category/source counts |
| `GET` | `/api/feed?status=&type=` | List up to 100 attention items |
| `GET` | `/api/settings` | Read preferences |
| `PUT` | `/api/settings` | Replace supported preferences |
| `POST` | `/api/items/:id/status` | Set `{status:"open"|"done"}` |
| `POST` | `/api/items/:id/snooze` | Set future ISO `{until}` |
| `POST` | `/api/items/:id/feedback` | Set useful/not-relevant/category correction |
| `GET` | `/api/items/:id/calendar.ics` | Download calendar event if dated |
| `GET` | `/api/stream` | Server-sent events |

Feed `status` is `open`, `snoozed`, `done` or `all`. Feed `type` is `payment`, `meeting`, `reminder` or `all`.

Settings body:

```json
{
  "contextAware": false,
  "outgoingMonitoring": false,
  "attachmentProcessing": false,
  "dailyDigest": false,
  "digestTime": "19:00",
  "timeZone": "Europe/Bucharest",
  "replyDelayHours": 8
}
```

SSE event names are `ready`, `item`, `groups`, `contacts`, `gmail-sources`, `rules`, `bridge` and `settings`.

## Sources

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/groups` | Known groups and selection state |
| `POST` | `/api/groups/:id/selection` | Set `{selected}` |
| `GET` | `/api/contacts` | Known people and selection state |
| `POST` | `/api/contacts/:id/selection` | Set `{selected}` |
| `POST` | `/api/contacts/lookup` | Resolve `{phoneNumber}` through local bridge |
| `POST` | `/api/contacts/import` | Resolve up to 100 `{phoneNumber,name}` entries |
| `GET` | `/api/gmail/sources` | Known Gmail labels/senders and selection state |
| `POST` | `/api/gmail/sources/:id/selection` | Set `{selected}` |

Selections affect only new events. Phone numbers must contain 8–15 digits after punctuation is removed.

## Rules and semantic detection

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/rules` | List rules |
| `POST` | `/api/rules` | Create a rule |
| `PUT` | `/api/rules/:id` | Update a rule |
| `DELETE` | `/api/rules/:id` | Delete a rule |
| `POST` | `/api/rules/:id/enabled` | Set `{enabled}` |
| `POST` | `/api/rules/test` | Test `{rule,text}` |
| `GET` | `/api/detection/status` | Jev status/model/threshold |
| `POST` | `/api/detection/test` | Run built-in Jev sample evaluation |

Phrase rule body:

```json
{
  "name": "Permission form",
  "kind": "phrase",
  "terms": ["formular", "acord semnat"],
  "matchMode": "any",
  "category": "reminder",
  "scope": "all",
  "sourceIds": [],
  "notify": true,
  "enabled": true
}
```

Semantic rule body:

```json
{
  "name": "Deliveries and reservations",
  "kind": "semantic",
  "condition": "A parcel, booking, ticket, address or pickup requires attention.",
  "threshold": 0.8,
  "category": "reminder",
  "scope": "sources",
  "sourceIds": ["15550100001@s.whatsapp.net"],
  "notify": true,
  "enabled": true
}
```

Limits are 100 total rules, 20 semantic rules, 30 phrase terms and 200 source IDs per rule.

## Push and WhatsApp control

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/push/key` | VAPID public key and enabled state |
| `POST` | `/api/push/subscription` | Save a browser PushSubscription |
| `GET` | `/api/whatsapp/status` | Live bridge state with stored fallback |
| `POST` | `/api/whatsapp/pairing-code` | Request code for `{phoneNumber}` |
| `GET` | `/api/whatsapp/qr.svg` | Proxy the current QR SVG |

## Gmail control

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/gmail/status` | OAuth/synchronization state |
| `POST` | `/api/gmail/connect` | Create a single-use Google authorization URL |
| `GET` | `/api/gmail/oauth/callback` | Google redirect; protected by OAuth state rather than the Strict cookie |
| `POST` | `/api/gmail/disconnect` | Revoke access and remove local OAuth credentials |

## Internal bridge API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/internal/routing` | Selected source IDs and media/outgoing flags |
| `POST` | `/internal/groups` | Upsert `{groups:[...]}` metadata |
| `POST` | `/internal/contacts` | Upsert `{contacts:[...]}` metadata |
| `POST` | `/internal/gmail/sources` | Upsert `{sources:[...]}` label/sender metadata |
| `POST` | `/internal/events` | Ingest one normalized message |
| `POST` | `/internal/status` | Store and broadcast bridge state |

Example normalized event:

```json
{
  "id": "stable-connector-event-id",
  "sourceId": "15550100001@s.whatsapp.net",
  "sourceName": "Example person",
  "sourceKind": "contact",
  "senderId": "15550100001@s.whatsapp.net",
  "senderName": "Example person",
  "sentAt": "2026-10-02T12:00:00.000Z",
  "text": "Please remember the signed form tomorrow.",
  "direction": "incoming",
  "media": null
}
```

`POST /internal/events` is idempotent for a stable message ID. It can return `accepted:false` for an invalid or unselected source, `accepted:true` with no items when nothing matches, or the new attention items.

## Bridge control API

The app proxies to the bridge control service; it should never be exposed to browsers directly. All routes require `X-Bridge-Token`.

| Method | Path on bridge | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Bridge process/connection health |
| `GET` | `/status` | Connection/account/QR availability |
| `GET` | `/qr.svg` | Current QR code |
| `POST` | `/pairing-code` | Request WhatsApp phone pairing code |
| `POST` | `/contact-lookup` | Resolve one number |
| `POST` | `/contacts-lookup` | Resolve up to 100 numbers |

The Gmail connector has corresponding token-protected `/health`, `/status`, `/oauth/start`, `/oauth/callback` and `/disconnect` routes. They are reachable only by the app container.

## Errors

Errors are JSON objects with an `error` code and sometimes a human-readable `message`. Typical statuses are:

- `400` invalid input or state;
- `401` unregistered browser;
- `403` wrong browser origin;
- `404` unknown resource or hidden privileged endpoint;
- `413` body too large;
- `429` invitation redemption throttled;
- `503` bridge or Jev temporarily unavailable.
