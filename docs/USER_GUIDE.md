# Threadmark user guide

Threadmark turns selected WhatsApp conversations into a private attention inbox. It watches only new messages from chats you enable and surfaces payments, meetings, deadlines, requests and other topics you define.

The WhatsApp connection is read-only by design: Threadmark does not send replies, mark chats as read, publish presence or import chat history.

## First-time setup

1. Ask the administrator for a single-use Threadmark invitation.
2. Open the invitation in the browser you want to register.
3. Give the device a recognizable name and choose **Activate this device**.
4. Open **Connect**, then link WhatsApp using a QR code or phone-number pairing code.
5. Open **Chats** and enable only the groups and people Threadmark should monitor.
6. If wanted, open **Settings** and enable attachment reading, context-aware updates, reply monitoring or the daily digest.
7. Enable browser notifications from the **Enable alerts** button.

Install the PWA from the browser menu for a full-screen experience and more reliable notification handling. HTTPS is required outside localhost.

## Choose monitored chats

Groups and people are off by default. Selecting a chat affects only messages received afterward; Threadmark does not scan older WhatsApp history.

In **Chats**:

- Switch between **Groups** and **People**.
- Search by name or phone number.
- Enable or disable any known source with its switch.
- Enter a complete international phone number to look up a person not yet shown.
- Use **Import from phone** where Contact Picker is supported, or import a `.vcf` file elsewhere.

Contact import sends only the selected phone numbers to the local WhatsApp bridge for existence lookup. Imported contacts remain disabled until you turn them on.

## Understand the inbox

The overview shows the number of open items, payments and meetings. Use the category tabs to show all items, payments, meetings or reminders. Use the status control for open, snoozed and completed items.

Each card includes:

- the detected category and title;
- the selected group or person and the sender;
- the message excerpt, expandable with **Show full message**;
- the detection source: **Rule**, **Jev** or **Review**;
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

## Notifications and daily digest

Choose **Enable alerts** and approve the browser permission. Notifications require all of the following:

- a secure HTTPS origin, except for localhost;
- working VAPID keys on the server;
- notification permission for the installed PWA or browser;
- an operating system that allows notifications for that browser;
- a rule or detector with alerts enabled.

Threadmark sends notifications for newly matched items and due or expired snoozes. Urgent detections use an urgent title. The app icon is used as both notification icon and badge.

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

Local built-in detection and phrase rules run first. Otherwise-unmatched selected-chat text is sent to TypeSafe AI when Jev is enabled. The Jev card at the top of **Rules** shows its status and expands to provide a direct sample tester.

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
- **Reply monitoring** recognizes requests for an answer and closes a reply reminder when your outgoing response arrives.

When either is enabled, a rolling local context buffer is retained for at most 48 hours. Recent text and incoming/outgoing direction may be included in Jev evaluation; identities and WhatsApp IDs are not sent.

## Privacy checklist

- Select only chats you intend to monitor.
- Prefer phrase rules for predictable sensitive wording.
- Leave Jev, context, replies and attachments disabled unless their benefit justifies the wider processing boundary.
- Revoke lost or unused browsers from the private invitation console.
- Keep the server, its backups and WhatsApp session volume private.
- Verify any payment warning independently before transferring money.

See [Privacy and security](PRIVACY.md) for the full data-flow explanation.

## Common problems

**A group or person is missing**
Wait for WhatsApp metadata to synchronize, receive a new message from that source, search by full international number, or import the contact.

**A newly selected chat has no old items**
This is expected. Selection applies only to new messages and history is not scraped.

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
