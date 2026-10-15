# Threadmark user guide

Threadmark turns selected WhatsApp conversations and Gmail sources into a private attention inbox. It watches only new messages from sources you enable and surfaces payments, meetings, deadlines, requests and other topics you define.

Both connections are read-only by design: Threadmark does not send replies or email, change read state, delete content, publish presence or import history.

## First-time setup

1. Ask the administrator for a single-use Threadmark invitation.
2. Open the invitation in the browser you want to register.
3. Give the device a recognizable name and choose **Activate this device**.
4. Open **Connect**, then link WhatsApp using a QR code or phone-number pairing code.
5. Optionally connect Personal Gmail, switch to **Dev**, and connect the development Gmail account. The administrator must configure Google OAuth first.
6. Open **Chats** and enable only the groups, people, Gmail labels or Gmail senders Threadmark should monitor.
7. If wanted, open **Settings** and enable attachment reading, context-aware updates, reply monitoring or the daily digest.
8. Enable browser notifications from the **Enable alerts** button.

Install the PWA from the browser menu for a full-screen experience and more reliable notification handling. HTTPS is required outside localhost.

## Personal and Dev profiles

Use the **Personal / Dev** switch above the inbox. Each profile has its own feed, counters, Done/Snoozed/Promotional views, Gmail sources and rules. WhatsApp belongs to Personal. The active profile is remembered on the device, and a Dev notification opens directly in the Dev tab.

The switch stays visible below the header as you scroll, on desktop and mobile. Each tab shows that profile's **Needs attention** count, including zero; counts above 99 appear as **99+**. These badges count open Inbox items, excluding snoozed and Promotional items, regardless of the category or status view you are browsing. Both profiles' badges update on live item changes and when you reopen or return to the PWA, so you can check the other profile without switching to it.

The two Gmail authorizations are isolated: connecting Dev does not replace Personal. Both remain read-only, but authorization alone does not enable monitoring. After connecting either account, select at least one Gmail label or sender for that profile. Dev begins with editable semantic monitors for security/access changes, failed builds or deployments, store/policy actions, direct review requests and actionable user reports. These monitors are scoped to Dev and are not copied to Personal; delete, disable or tune them from **Rules** without affecting Personal.

## Choose monitored sources

Every source is off by default, including Gmail **INBOX**. Selecting one affects only messages received afterward; Threadmark does not scan older WhatsApp or Gmail history. Connecting or reconnecting Gmail establishes a current history checkpoint, so mail received before that checkpoint is not imported later.

In **Chats** for the selected profile:

- Switch between **Groups**, **People**, **Gmail labels** and **Senders**.
- Search by name or phone number.
- Enable or disable any known source with its switch.
- Enter a complete international phone number to look up a person not yet shown.
- Use **Import from phone** where Contact Picker is supported, or import a `.vcf` file elsewhere.

Contact import sends only the selected phone numbers to the local WhatsApp bridge for existence lookup. Imported contacts remain disabled until you turn them on.

Gmail labels appear after connection. Senders are discovered from the headers of new mail and remain disabled until selected. Full bodies are fetched only after a label or sender matches; email attachments are not downloaded. A detected email card includes **Open in Gmail** under **Actions**.

Rules are also profile-specific. A selected Dev source is evaluated only by Dev rules, while a selected Personal source is evaluated only by Personal rules. For example, to monitor security notices in Personal, create a semantic monitor such as:

- **Name:** Security or access change
- **Condition:** A security, authentication, permission, password, key, token, vulnerability, sign-in or account-access change affects an account or service I use.
- **Type:** Reminder
- **Threshold:** 80%
- **Scope:** All monitored sources
- **Notify:** On

## Understand the inbox

The overview shows the number of open items, payments and meetings. Use the category tabs to show all items, payments, meetings or reminders. Use the status control for open, snoozed and completed items.

The inbox opens with a compact title and notification control, followed by a single row of counters. This keeps messages visible sooner, especially on phones. The Personal/Dev switch remains visible while scrolling.

When the installed PWA is opened or brought back from the background, Threadmark refreshes the counters and current feed from the server and reconnects its live update stream. A manual page reload should not be necessary.

Each card includes:

- the detected category and title;
- the selected group or person and the sender;
- the message excerpt, expandable with **Show full message**; tap the expanded message body to collapse it again;
- the detection source: **Rule**, **Jev**, **Rule + Jev** or **Review**;
- confidence, due date, urgency and attachment badges when available;
- payment warnings when details look changed, duplicated or unusual.

High-urgency items are sorted above ordinary items. A probability is evidence for review, not a guarantee that a classification is correct.

## Act on an item

Open **Actions** on a card to:

- mark it done or reopen it;
- snooze it until a later time;
- add a dated item to a calendar using an `.ics` file;
- mark the result useful or not relevant;
- correct its category.

Feedback is stored locally for audit and does not currently retrain the detectors automatically. A “not relevant” item is also marked done.

When Jev is enabled, new alert candidates store promotional-purpose, personal-obligation, transactional/administrative and recipient-specific probabilities. A narrow Gmail policy moves strongly promotional, low-relevance candidates to the **Promotional** status view. Generic payment matches can also move there when Jev confidently identifies an optional offer rather than a real financial matter. These items do not notify, carry an actionable due date or count as open Inbox items, but are not deleted. Select **Move to inbox** if Jev was wrong, or **Not relevant** to resolve the item. Invoices, subscription events, explicit payment requests, bank instructions, your phrase rules, your semantic monitors and photo-review alerts stay protected. WhatsApp uses a stricter policy: only near-certain promotions with almost no personal obligation are moved, such as a priced workshop invitation posted in a group; payments Threadmark found with its own rules are never moved. The policy applies only to newly received messages.

Payment warnings compare the same sender's previous payments, rather than unrelated mail in the same Gmail label. Alerts marked **Not relevant** and items in **Promotional** are excluded from those comparisons. Deadline detection distinguishes actual tasks from story dates, advice and offer expiry dates; percentages and performance multipliers are not calendar dates.

## Notifications and daily digest

Choose **Enable alerts** and approve the browser permission. Notifications require all of the following:

- a secure HTTPS origin, except for localhost;
- working VAPID keys on the server;
- notification permission for the installed PWA or browser;
- an operating system that allows notifications for that browser;
- a rule or detector with alerts enabled.

Threadmark sends notifications for newly matched Inbox items and due or expired snoozes. Alerts are gathered into one notification per profile: while it is still on screen, each new alert updates it to a summary such as **3 alerts · 2 payments, 1 action**, listing the latest three. A single alert keeps its **Done** and **Actions** buttons; tapping a summary opens that profile's inbox. Dismissing the notification, or opening Threadmark, clears it, and the next alert starts a fresh count. Browsers that cannot list their notifications show one notification per alert. Items routed to Promotional are quiet. Dev notifications are prefixed with **Dev** and open that profile; the operating system still groups both profiles under the single Threadmark PWA. Urgent detections use an urgent title. The app icon is used as both notification icon and badge. On platforms that support Web Notification actions, **Done** completes the item directly from the notification and **Actions** opens the matching card with its action menu expanded. If direct completion fails, Threadmark opens the item instead.

The optional daily digest is configured under **Settings**. It reports the number of open payments, meetings and reminders at the selected local time.

If the button says **Alerts blocked**, open the browser or operating-system site settings, allow notifications for the Threadmark origin, then reload the PWA.

## Create local phrase rules

Use a phrase rule when the wording is predictable and the message should stay entirely local.

1. Open **Rules** and choose **New rule**.
2. Keep **Phrase rule · local** selected.
3. Add a concise name and one phrase per line.
4. Choose whether any phrase or all phrases must occur.
5. Choose payment, meeting or reminder.
6. Apply it to all monitored chats or selected sources.
7. Decide whether matches should notify you.
8. Test a representative message, then save.

Matching ignores case and accents but otherwise checks literal phrases. Rules affect only future messages.

## Create semantic Jev monitors

Use a semantic monitor when meaning matters more than exact words—for example deliveries, permissions or messages that need a decision.

1. Open **Rules** and choose **New rule**.
2. Select **Semantic monitor · Jev**.
3. Describe one narrow condition in plain language.
4. Set the category, chat scope, alert behavior and probability threshold.
5. Test a representative sample and save.

A higher threshold reduces false positives but can miss borderline messages. Start around 78–82%, review actual results and adjust gradually.

Local built-in detection and phrase rules run first. Concrete invoice notices in Romanian or English are shown as Payment items even when the message does not contain an amount or IBAN. Direct invoice wording can match on its own; otherwise billing context, an amount or bank details must appear close to the invoice term. This works for both selected WhatsApp chats and Gmail sources and produces an **Invoice received** alert. A receipt or order confirmation for money already paid is treated as informational and is not shown unless it also asks you to act or reports a real subscription purchase, start, renewal/re-subscription, price change, expiration, cancellation or payment failure. Subscription events appear under **Payments** and use a **Subscription update** notification. Clearly labeled test purchase receipts remain quiet. Ambiguous or otherwise-unmatched selected-source text is sent to TypeSafe AI when Jev is enabled; a narrow invoice judgment uses a 68% default threshold because missing a bill is more costly than showing an occasional extra item. Local Gmail meeting candidates are also checked by Jev to reject newsletter or marketing false positives; confirmed items show **Rule + Jev**. Other candidates receive promotional, obligation, transactional and recipient-specific scores. Gmail messages meeting the conservative promotional policy appear quietly under **Promotional**; protected alert types and all WhatsApp alerts remain visible. If Jev is unavailable, Threadmark keeps local detections rather than silently losing them. The Jev card at the top of **Rules** shows its status and expands to provide a direct sample tester.

## Attachments and handwritten assignments

Enable **Read attachments locally** under **Settings** to process supported attachments:

- images: Romanian and English Tesseract OCR;
- PDFs: embedded text first, then first-page OCR as a fallback;
- voice notes: local multilingual transcription through whisper.cpp.

Files are downloaded into a temporary directory inside the bridge container and removed immediately after processing. Extracted text enters the same detector pipeline as a typed message.

Handwriting is intrinsically harder for the bundled OCR. If an image from a monitored individual contact produces no reliable text, Threadmark creates a **Photo needs review** item so you can inspect the original in WhatsApp. Threadmark does not keep a copy of the image.

For better handwritten results, photograph the page straight on, fill the frame, avoid shadows, use high contrast and send the original-resolution image rather than a screenshot of it.

## Context, changes and replies

These features are off by default because they widen the amount of selected-chat text held and analyzed:

- **Context-aware updates** detects corrections, cancellations and schedule changes using recent messages from the same selected source.
- **Reply monitoring** recognizes requests for an answer and closes a reply reminder when your outgoing response arrives. In WhatsApp groups with more than five people, a question becomes **Reply requested** only when it mentions you or replies to one of your messages; in smaller groups and private chats every question counts. A message in a larger group that opens by addressing someone else by name ("Bună Maria, …") does not create Jev reminders for you.

When either is enabled, a rolling local context buffer is retained for at most 48 hours. Recent text and incoming/outgoing direction may be included in Jev evaluation; identities and WhatsApp IDs are not sent.

## Privacy checklist

- Select only chats you intend to monitor.
- Prefer phrase rules for predictable sensitive wording.
- Leave Jev, context, replies and attachments disabled unless their benefit justifies the wider processing boundary.
- Revoke lost or unused browsers from the private invitation console.
- Keep the server, its backups and WhatsApp session volume private.
- Treat the Gmail connector volume and protected environment file as mailbox credentials.
- Verify any payment warning independently before transferring money.

See [Privacy and security](PRIVACY.md) for the full data-flow explanation.

## Common problems

**A group or person is missing**
Wait for WhatsApp metadata to synchronize, receive a new message from that source, search by full international number, or import the contact.

**A newly selected chat has no old items**
This is expected. Selection applies only to new messages and history is not scraped.

**Gmail says it needs attention**
Open **Connect** and reconnect. If this repeats after seven days, ask the administrator to move the personal OAuth consent screen out of Testing mode.

**Gmail is connected but a message was missed**
Switch to the profile that owns the account and check **Chats**. At least one matching Gmail label or sender must be enabled in that profile; **INBOX** is not enabled automatically. Then confirm that the same profile has an applicable built-in, phrase or semantic rule. Dev's preset monitors do not apply to Personal. Messages received before the latest connection or reconnection checkpoint are not backfilled. If the source and rule were active before the message arrived, inspect the Jev state and test representative synthetic wording from **Rules**.

**A custom rule did not match**
Confirm it is enabled, its scope includes the source and the message arrived after the rule was saved. Test the exact wording. For phrase rules, check the any/all setting; for semantic rules, lower the threshold carefully.

**Jev items do not appear**
Open **Rules** and inspect the Jev state. The administrator should check the API key, `JEV_ENABLED`, service logs and outbound connectivity.

**Notifications do not arrive**
Open Threadmark once after installation, check site and OS permission, make sure alerts are enabled, and verify the PWA still has a valid device session.

**The PWA shows an old interface**
Reload once. If it remains stale, visit `/bust`, then reopen Threadmark; this clears the app cache and lets the current service worker install.

**WhatsApp is offline**
Open **Connect**. If the account was logged out, pair it again. An ordinary network interruption should reconnect automatically.
