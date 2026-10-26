# Voice messages

Enable **Preferences → Transcribe voice messages locally**, select the WhatsApp chats to monitor, and open **Voice messages** in the Personal profile. Newly received incoming recordings appear even when no payment, task or meeting is detected. This is independent of the image/PDF setting and is off by default.

The view provides sender/chat/time, available duration, full transcript, pending/processing/failure status, WhatsApp links and eligible retries. Voice cards do not change attention counters or send alerts. **Find actions in transcripts** is a separate, disabled-by-default option; it explicitly allows the existing detectors, including Jev when configured, to analyze transcript text.

Limits are 20 MiB, ten minutes per recording, fifty pending/running jobs and one recognizer at a time. Download references expire after 24 hours and there are three total attempts, including restart recovery. Recordings that are no longer downloadable in WhatsApp cannot be recovered by retry. View-once audio and historical backfill are excluded. The view lists the latest 200 records and retains them under the normal retention setting, even if no attention item exists.

Audio stays in temporary local storage and is removed after each attempt; the container definitions use a memory-backed `/tmp`. The bridge retains only the temporary WhatsApp reference needed for a retry, not the recording. Completed transcripts stay in the app until retention removes them. Disabling transcription cancels unfinished work; completed text is not immediately erased.

## Model and validation

The default is multilingual Whisper **small**, running through whisper.cpp **v1.9.4** with automatic language detection and two CPU threads. The bundled model has SHA-256 `1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b`, verified during the bridge build. Optional bridge container overrides are `WHISPER_MODEL` (a model path) and `WHISPER_THREADS` (1–4). Models are not downloaded during transcription.

Synthetic speech smoke checks used espeak-ng to generate short Romanian and English recordings, converted them to Ogg/Opus, and ran the real media pipeline in a network-disabled container with no account data mounted. Temporary-file cleanup succeeded. Observed time including audio conversion and model loading:

| Model | Romanian | English |
| --- | --- | --- |
| tiny | 3.05 s | 2.59 s |
| base | 5.82 s | 5.38 s |
| small | 20.20 s | 18.26 s |
| small Q5_1 | 35.13 s | 33.61 s |

These are exploratory single-run measurements on a shared CPU server, not a controlled performance benchmark or production accuracy estimate. The quantized run overlapped preview-image preparation. Small preserved more of the Romanian sentence than tiny/base, while still making word/time mistakes. The unquantized small checkpoint was selected for this initial implementation; these samples do not establish that quantization is generally slower. Neither these timings nor the earlier Jev model evaluation predict recognition quality on real recordings. Names, numbers, noise and very short speech remain failure cases to assess locally before relying on transcript-derived actions.

## Checks and deployment

```bash
npm test
node scripts/voice-browser-check.mjs /tmp/threadmark-voice-preview
podman build -t localhost/threadmark-app:voice-preview -f deploy/Containerfile.app .
podman build -t localhost/threadmark-bridge:voice-preview -f deploy/Containerfile.bridge .
```

The browser check starts an isolated temporary app and fake bridge with authored fixtures. It checks live statuses, retry, ordinary transcripts without alerts, no semantic calls, escaping, profile isolation, foreground recovery without SSE, and layouts at 1440, 390 and 360 pixels. The unit/API suites cover eligibility, current consent, stale-attempt rejection, serial execution, restart recovery, retry bounds, expiry, cancellation, download/recording limits and cleanup.

Validation snapshot (2026-10-26): all **93 tests** and the browser check passed. Both preview images built successfully and their packaged source hashes matched the workspace. A network-isolated app-image smoke test stored a transcript with zero attention items. The final bridge image transcribed the same synthetic Romanian/English recordings using its bundled default model in 19.64 / 18.21 seconds, with temporary audio removed in both cases. These checks used no real WhatsApp recording or account data. [Desktop preview](images/voice/voice-desktop.png) · [Mobile preview](images/voice/voice-mobile.png).

Deploying requires updated app and bridge images and recreation of the bridge to apply its `/tmp` mount. The model changes from tiny to small, so rebuilding takes longer and the image is larger. No database reset or WhatsApp relinking is required. The new table and preferences are added automatically. Previously enabled **Read attachments locally** now covers images/PDFs; voice transcription is deliberately a separate new opt-in.

Contact links open their WhatsApp chat. Group links open WhatsApp (the app on mobile, WhatsApp Web on desktop), rather than a specific group or voice message. Automatic transcript text can contain mistakes, and transcription errors/failures remain visible instead of silently inventing attention items.

Optional action analysis initially treats delayed transcripts as standalone messages: it does not automatically cancel/reschedule an existing item or create an awaiting-reply reminder from voice context. This prevents late transcription from overwriting newer typed conversation state. Standalone payments, meetings, tasks and configured monitors still use the normal detectors.
