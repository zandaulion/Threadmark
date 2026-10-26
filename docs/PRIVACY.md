# Privacy and security

Threadmark is designed for a personal, private server, but it is not a zero-risk product. It uses an unofficial WhatsApp linked-device connector, read-only Gmail OAuth, and can optionally send selected message text to TypeSafe AI. This document makes those boundaries explicit.

The deployment also serves a concise public policy for OAuth users at `/privacy` and an application overview at `/about`. Keep those public pages aligned with this technical document whenever data flows change.

## Default data boundary

Groups and contacts are disabled until selected. For a new incoming message:

1. the relevant local connector receives and normalizes the event; the WhatsApp bridge removes the text and media of messages from unselected chats before queuing them, so only source metadata leaves it;
2. the local app checks its source against the allowlist;
3. unselected content is rejected before detection and long-term storage;
4. selected content runs through local detectors and phrase rules;
5. only a matched message excerpt and its attention item are stored.

Threadmark does not request full history, send messages, mark chats as read or publish online presence. Contact and group metadata may be retained so the selection screen can show available sources.

Each Gmail profile begins at its own current mailbox checkpoint and does not import old messages. Personal and Dev use separate encrypted tokens, checkpoints, outboxes, allowlists, rules and feeds. Labels and headers of new messages are checked locally. Threadmark fetches a complete body only when an enabled label or sender matches, never fetches attachments, and cannot send, delete, modify or mark email as read.

## What can leave the machine

| Situation | Destination | Payload |
| --- | --- | --- |
| WhatsApp linked-device operation | WhatsApp infrastructure | Protocol traffic required for the linked device |
| Gmail synchronization | Google Gmail API | OAuth tokens, message IDs, labels/headers, and complete bodies only for enabled sources |
| Jev enabled, local checks find no match | TypeSafe AI | Selected message text and batched semantic questions, including the narrow invoice judgment |
| Jev enabled, local checks find a Gmail meeting candidate | TypeSafe AI | Selected email text and batched semantic questions used to confirm or reject the meeting |
| Jev enabled, local checks create any other alert candidate | TypeSafe AI | Selected message text and sanitized channel/bulk-mail booleans used to estimate promotional purpose, obligation, transactional relevance and recipient specificity, with a focused payment judgment for generic payment matches; a narrow Gmail policy can route the item quietly to Promotional |
| Semantic rule sample test | TypeSafe AI | The sample text and monitor condition |
| Context/reply features enabled | TypeSafe AI | Current text plus up to six recent selected-source text snippets and direction labels |
| Web Push enabled | Browser push service | Notification title, selected source name, matched title, item URL/tag/identifier and Done/Actions metadata |

Threadmark does not intentionally send TypeSafe AI the chat name, sender name, email address, phone number, WhatsApp source ID, Gmail message ID or raw email-header values. It can send only coarse context such as Gmail/WhatsApp, group/individual/mailbox and boolean Gmail bulk hints. Gmail items routed to Promotional remain in the local database and do not produce push notifications; they are not sent to an additional service. Jev provider-side handling and retention are governed by TypeSafe's terms and configuration, not by the local Threadmark database.

Web Push necessarily passes an encrypted push payload through the browser vendor's push service. Although its contents are encrypted to the subscription, notification text can still appear on a locked screen depending on device settings.

## What remains local

- WhatsApp linked-device credentials
- bridge outbox
- separate encrypted Personal and Dev Gmail OAuth state, checkpoints and outboxes
- known WhatsApp/Gmail source metadata and selection state
- matched message excerpts and attention items
- local and semantic rule definitions
- settings, device records and feedback
- extracted OCR text before normal detector routing and, when separately enabled, voice transcripts even without an attention match
- the optional 48-hour context buffer

Phrase rule test samples are evaluated in the browser/server flow locally and are not saved. Jev sample tests are sent to TypeSafe and are not saved by Threadmark.

## Attachments

Image/PDF processing and voice transcription are separate, off-by-default settings. For selected sources the bridge downloads and decrypts media into a mode-restricted temporary directory, performs local extraction, then deletes that directory in a `finally` path on success, failure or cancellation. Container deployments mount temporary storage in memory; startup also removes stale media staging from previous crashes and older bridge versions.

Limits and behavior:

- maximum media size: 20 MiB;
- images: Tesseract `ron+eng`;
- PDFs: embedded text or first-page OCR;
- audio: FFmpeg conversion and local multilingual whisper.cpp, one recording at a time, maximum ten minutes;
- videos: metadata only, no content extraction;
- original media is not stored by Threadmark;
- image/PDF text follows the normal local/Jev routing;
- voice transcripts stay in the local Voice messages view unless **Find actions in transcripts** is also enabled; only then can they enter the existing local/Jev action pipeline;
- voice metadata and transcripts are stored independently of attention items and follow `RETENTION_DAYS`;
- references and keys for downloading encrypted WhatsApp media, plus limited source metadata, stay in the owner-only bridge queue for retries for up to 24 hours. This is local credential storage, not an additional encrypted-at-rest vault. References are removed on success, cancellation, final failure or expiry; they are never sent to the app or TypeSafe. Quoted-message text is stripped from them;
- view-once recordings are not transcribed. Processing applies only to new incoming audio, not chat-history backfill.

If OCR cannot read an image from a monitored individual contact, Threadmark keeps only a reminder that the original photo needs review in WhatsApp.

## Retention

`RETENTION_DAYS` defaults to 30. Once per minute the app deletes expired context and messages older than that cutoff unless they still back an open attention item. The related completed attention item is removed through the database cascade when its message is pruned. Open items remain until resolved, even beyond the cutoff. The app database and both connector outboxes use SQLite `secure_delete`, so deleted and pruned text is overwritten rather than left in free pages.

Voice records are also pruned on this schedule, independently of attention matches. If transcript text was explicitly used to create an action, the excerpt supporting an open attention item follows the open-item retention rule above. Disabling transcription cancels unfinished voice work but does not erase completed transcripts immediately.

Context messages expire after 48 hours. Disabling both context-aware and outgoing-message monitoring immediately clears that context table.

Connector credentials, source metadata, rules, settings, active browser devices and outbox entries do not use the message retention timer. Remove them deliberately by revoking/deleting devices, disconnecting services, deleting rules or retiring the deployment securely.

## Credentials and access control

- `ADMIN_TOKEN` grants invitation and device administration. It belongs only in the private console route and protected environment file.
- `BRIDGE_TOKEN` authenticates all internal source/event and bridge-control traffic.
- `GOOGLE_CLIENT_SECRET` and `GMAIL_TOKEN_ENCRYPTION_KEY` live only in the Gmail connectors' environment file.
- Gmail refresh tokens are encrypted at rest in separate profile volumes. Possession of either Gmail volume plus the encryption key grants read-only access to that mailbox until revoked.
- WhatsApp auth state in the bridge volume can act as the linked account and must be treated as a high-value credential.
- TypeSafe and VAPID private keys live only in the app's environment file. The WhatsApp bridge, which parses untrusted media, receives no secret except `BRIDGE_TOKEN`.
- Browser device tokens are random, stored in an HttpOnly SameSite cookie and represented only by hashes in SQLite.
- Invitations are single-use, expire and can be revoked.

Use an environment file with mode `0600`, encrypted backups and a private HTTPS network. Revoke a browser immediately if a device is lost.

## Network exposure

The supported production posture is:

- app bound to `127.0.0.1:4391`, serving only browser routes;
- connector endpoints (`/internal/*`) served only on the unpublished internal port 4390;
- connectors not published to the host;
- pages served with a same-origin Content-Security-Policy, `frame-ancestors 'none'` and HSTS;
- private HTTPS access through Tailscale or an equivalently restricted proxy;
- public route never carrying the admin token;
- containers running rootless, without Linux capabilities and with `no-new-privileges`.

Do not expose connector control endpoints or the unauthenticated HTTP app port to a LAN or the public internet.

## Logging and cache behavior

The application is designed not to print message content. Errors use general codes and service information; unexpected errors are not described to the browser. The bridge suppresses libsignal's session-record dumps, which include private ratchet keys. Avoid enabling verbose dependency/protocol logging in production unless you have reviewed what it emits.

API and internal responses use `Cache-Control: no-store` and are excluded from service-worker caching. The service worker caches only static application assets. Browser notification surfaces, OS notification history and reverse-proxy logs are separate systems that require their own privacy configuration.

## Threat model and remaining risks

Threadmark reduces accidental overcollection; it does not protect against a fully compromised server, browser, WhatsApp account or administrator account.

Material risks include:

- WhatsApp changing or restricting the unofficial Baileys connection;
- Google revoking an OAuth token, changing Gmail API policy or requiring renewed consent;
- false positives or missed detections from rules, OCR or Jev;
- sensitive excerpts appearing in push notifications or browser history;
- TypeSafe AI receiving selected text within the enabled semantic boundary;
- credentials leaking through weak host permissions or unencrypted backups;
- another host process with the same user permissions reading local data;
- a selected high-volume chat producing more retained items than expected.

Threadmark is an attention aid, not a financial fraud detector, emergency service, legal record or guaranteed reminder system. Verify important payments and deadlines at their original source.

## Recommended hardening checklist

- Keep the OS, Podman, Node images and dependencies updated.
- Restrict access with Tailscale ACLs or equivalent identity-aware controls.
- Use a dedicated HTTPS origin and keep Secure cookies enabled.
- Back up encrypted; test restoration; restrict the backup key separately.
- Keep Jev/context/attachment features off unless needed.
- Prefer narrow semantic monitors and source scopes.
- Review selected chats and registered devices periodically.
- Use lock-screen notification redaction if message titles are sensitive.
- Monitor service logs and health without adding message bodies to logs.
- Retire the linked WhatsApp device from WhatsApp when decommissioning Threadmark.
- Disconnect Gmail and revoke Threadmark in Google Account access when decommissioning it.
