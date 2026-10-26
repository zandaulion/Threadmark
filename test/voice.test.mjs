import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { openDatabase, ThreadmarkStore } from '../app/server/store.mjs';
import { VoiceStore } from '../app/server/voice.mjs';
import { Outbox } from '../bridge/outbox.mjs';
import { VoiceJobs, VoiceWorker } from '../bridge/voice.mjs';
import { serializeVoiceMessage, deserializeVoiceMessage, processMessageMedia, cleanupMediaTemp } from '../bridge/media.mjs';

const sourceId = '15550100001@s.whatsapp.net';
const sample = (id = 'synthetic-voice') => ({ id, sourceId, sourceKind: 'contact', sourceName: 'Demo contact',
  senderName: 'Demo speaker', senderId: sourceId, sentAt: new Date().toISOString(), direction: 'incoming',
  durationSeconds: 8, text: '[Voice note]', media: { kind: 'audio', mimeType: 'audio/ogg' } });
const routing = () => ({ sourceIds: new Set([sourceId]), voiceTranscription: true, voiceActionDetection: false });
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadmark-voice-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('transcripts remain visible without an attention item; statuses are monotonic and profile isolated', (t) => {
  const db = openDatabase(temp(t)); t.after(() => db.close());
  const store = new ThreadmarkStore(db);
  const voices = new VoiceStore(db, store);
  store.upsertContacts([{ id: sourceId, name: 'Demo contact' }]);
  const event = { ...sample(), status: 'queued', attempt: 1 };
  assert.equal(voices.record(event), null, 'unselected voices cannot be stored');
  store.selectContact(sourceId, true);
  assert.equal(voices.record(event), null, 'transcription is separately opt-in');
  store.updateSettings({ voiceTranscription: true });
  assert.equal(store.routingConfig().voiceTranscription, true);
  assert.equal(store.settings().attachmentProcessing, false);
  assert.equal(store.routingConfig().voiceActionDetection, false);
  assert.equal(voices.record(event).status, 'queued');
  assert.equal(voices.record({ ...event, status: 'transcribing' }).status, 'transcribing');
  assert.equal(voices.record(event), null, 'late queued delivery cannot regress processing');
  const ready = { ...event, status: 'ready', transcript: 'Mulțumesc, o zi frumoasă!' };
  assert.equal(voices.record(ready).transcript, ready.transcript);
  assert.equal(voices.record({ ...event, status: 'failed' }), null);
  assert.equal(voices.list().length, 1);
  assert.equal(store.listItems({}).length, 0, 'ordinary speech does not need an attention item');
  assert.deepEqual(voices.list('dev'), []);
  assert.equal(voices.get(event.id, 'dev'), null);
  assert.equal(voices.record({ ...ready, id: 'outgoing', direction: 'outgoing' }), null);
  assert.equal(voices.record({ ...event, id: 'bad-attempt', attempt: 100 }), null);
  assert.equal(voices.record({ ...ready, id: 'bad-time', sentAt: 'invalid' }), null);
  const longTranscript = 'Mesaj de test. '.repeat(1200);
  assert.equal(voices.record({ ...ready, id: 'long-transcript', transcript: longTranscript }).transcript, longTranscript.trim(), 'reading is not limited to the detector input budget');
  assert.equal(voices.record({ ...ready, id: 'oversized-transcript', transcript: 'a'.repeat(64_001) }), null);
  voices.record({ ...event, id: 'cancel-me' });
  voices.record({ ...event, id: 'cancel-retry', status: 'failed', retryUntil: new Date(Date.now() + 3600_000).toISOString() });
  store.selectContact(sourceId, false);
  voices.cancelInactive();
  assert.equal(voices.get('cancel-me').error, 'source_unselected');
  assert.equal(voices.record({ ...ready, id: 'cancel-me' }), null);
  store.selectContact(sourceId, true);
  assert.equal(voices.get('cancel-retry').retryable, false, 'deselection invalidates failed references even if the source is later selected again');
  assert.equal(voices.record({ ...ready, id: 'cancel-me' }), null, 'late completion cannot resurrect cancelled work');
  db.prepare("UPDATE voice_notes SET created_at='2000-01-01T00:00:00.000Z'").run();
  store.prune(30);
  assert.equal(voices.list().length, 0);
});

test('background jobs survive restart, run serially, and publish text only after success', async (t) => {
  const outbox = new Outbox(temp(t)); t.after(() => outbox.close());
  let jobs = new VoiceJobs(outbox);
  assert.equal(jobs.enqueue(sample('one'), 'encrypted-reference'), true);
  assert.equal(jobs.enqueue(sample('one'), 'duplicate'), false);
  jobs.enqueue(sample('two'), 'second-reference');
  jobs.start(jobs.get('one'));
  jobs = new VoiceJobs(outbox);
  assert.equal(jobs.get('one').status, 'queued');
  assert.equal(jobs.get('one').attempt, 2, 'a resumed run advances the status version and consumes an attempt');
  let active = 0;
  let peak = 0;
  const worker = new VoiceWorker(jobs, { getRouting: async () => routing(), transcribe: async () => {
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    return { processed: true, extractedText: 'This is synthetic speech.' };
  } });
  await Promise.all([worker.kick(), worker.kick(), worker.kick()]);
  assert.equal(peak, 1);
  assert.equal(jobs.get('one').status, 'ready');
  assert.equal(jobs.get('one').envelope, null, 'download keys are removed on success');
  assert.equal(jobs.get('two').status, 'ready');
  const events = outbox.pending();
  assert.equal(events.filter((e) => e.payload.status === 'ready').length, 2);
  assert.equal(events.some((e) => e.endpoint === '/internal/events'), false, 'local transcription alone never enters JEV');
  assert.equal(JSON.stringify(events).includes('encrypted-reference'), false);
  await worker.close();
});

test('failed retries are bounded and old attempts cannot overwrite a newer job', async (t) => {
  const outbox = new Outbox(temp(t)); t.after(() => outbox.close());
  const jobs = new VoiceJobs(outbox);
  jobs.enqueue(sample(), 'reference');
  const worker = new VoiceWorker(jobs, { getRouting: async () => routing(), transcribe: async () => ({ error: 'local_processing_failed' }) });
  const first = jobs.get(sample().id);
  await worker.kick();
  assert.equal(jobs.get(first.id).status, 'failed');
  assert.equal(jobs.retry(first.id).attempt, 2);
  assert.equal(jobs.finish(first, { processed: true, extractedText: 'Stale text' }), false);
  await worker.kick();
  assert.equal(jobs.retry(first.id).attempt, 3);
  await worker.kick();
  assert.equal(jobs.retry(first.id), null);
  assert.equal(jobs.event(jobs.get(first.id)).retryUntil, null);
  assert.equal(jobs.get(first.id).envelope, null);
  await worker.close();
});

test('shutdown during routing lookup never starts a new audio download', async (t) => {
  const outbox = new Outbox(temp(t)); t.after(() => outbox.close());
  const jobs = new VoiceJobs(outbox);
  jobs.enqueue(sample(), 'reference');
  let release;
  let downloads = 0;
  const worker = new VoiceWorker(jobs, { getRouting: () => new Promise((resolve) => { release = resolve; }),
    transcribe: async () => { downloads++; return {}; } });
  worker.kick();
  const closed = worker.close();
  release(routing());
  await closed;
  assert.equal(downloads, 0);
  assert.equal(jobs.get(sample().id).status, 'queued');
});

test('repeated process interruptions cannot bypass the three-attempt limit', (t) => {
  const outbox = new Outbox(temp(t)); t.after(() => outbox.close());
  let jobs = new VoiceJobs(outbox);
  jobs.enqueue(sample(), 'reference');
  for (let attempt = 1; attempt <= 3; attempt++) {
    jobs.start(jobs.get(sample().id));
    jobs = new VoiceJobs(outbox);
  }
  assert.equal(jobs.get(sample().id).status, 'failed');
  assert.equal(jobs.get(sample().id).attempt, 3);
  assert.equal(jobs.get(sample().id).envelope, null);
  assert.equal(jobs.retry(sample().id), null);
});

test('deselection aborts in-flight speech and suppresses late transcripts and action events', async (t) => {
  const outbox = new Outbox(temp(t)); t.after(() => outbox.close());
  const jobs = new VoiceJobs(outbox);
  jobs.enqueue(sample(), 'reference');
  let current = { ...routing(), voiceActionDetection: true };
  let started;
  const began = new Promise((resolve) => { started = resolve; });
  const worker = new VoiceWorker(jobs, { getRouting: async () => current, transcribe: async (_, signal) => {
    started();
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    return { processed: true, extractedText: 'Must never be delivered.' };
  } });
  const running = worker.kick();
  await began;
  current = { ...current, sourceIds: new Set() };
  worker.reconcile(current);
  await running;
  assert.equal(jobs.get(sample().id).status, 'failed');
  assert.equal(jobs.get(sample().id).envelope, null);
  assert.equal(outbox.pending().some((row) => row.payload.transcript || row.endpoint === '/internal/events'), false);
  await worker.close();
});

test('queue limits, expiry and explicit action detection preserve delivery ordering', async (t) => {
  const outbox = new Outbox(temp(t)); t.after(() => outbox.close());
  let clock = Date.now();
  const jobs = new VoiceJobs(outbox, { now: () => clock, maxPending: 1 });
  jobs.enqueue(sample('one'), 'reference');
  jobs.enqueue(sample('overflow'), 'reference');
  assert.equal(jobs.get('overflow').error, 'queue_full');
  assert.equal(jobs.get('overflow').envelope, null);
  const worker = new VoiceWorker(jobs, { getRouting: async () => ({ ...routing(), voiceActionDetection: true }),
    transcribe: async () => ({ processed: true, extractedText: 'Please pay 25 lei.' }) });
  await worker.kick();
  const events = outbox.pending();
  const readyIndex = events.findIndex((row) => row.payload.status === 'ready');
  const actionsIndex = events.findIndex((row) => row.endpoint === '/internal/events');
  assert.ok(readyIndex >= 0 && actionsIndex > readyIndex);
  assert.equal(events[actionsIndex].payload.origin, 'voice_transcript');
  jobs.enqueue(sample('expire'), 'reference');
  clock += 86_400_001;
  jobs.expire();
  assert.equal(jobs.get('expire'), undefined);
  assert.equal(outbox.pending().some((row) => row.payload.id === 'expire' && row.payload.error === 'expired'), true);
  await worker.close();
});

test('retry references exclude quoted text and view-once audio', () => {
  const message = { key: { id: 'synthetic', remoteJid: sourceId }, message: {
    audioMessage: { url: 'https://example.invalid/encrypted', mediaKey: Buffer.from('synthetic'),
      contextInfo: { quotedMessage: { conversation: 'Unnecessary quoted private text' } } },
  } };
  const decoded = deserializeVoiceMessage(serializeVoiceMessage(message));
  assert.deepEqual(Buffer.from(decoded.message.audioMessage.mediaKey), Buffer.from('synthetic'));
  assert.equal(decoded.message.audioMessage.contextInfo, null);
  assert.equal(serializeVoiceMessage({ ...message, message: { viewOnceMessage: { message: message.message } } }), null);
  assert.equal(serializeVoiceMessage({ ...message, message: { audioMessage: { ...message.message.audioMessage, viewOnce: true } } }), null);
});

test('audio processing bounds duration and download size, and deletes files on success, failure and cancellation', async (t) => {
  const dir = temp(t);
  const message = { message: { audioMessage: { mimetype: 'audio/ogg' } } };
  let whisperCalls = 0;
  const execute = async (program, args) => {
    if (program === 'ffprobe') return { stdout: '8.2\n' };
    if (program.endsWith('whisper-cli')) {
      whisperCalls++;
      await fs.promises.writeFile(`${args[args.indexOf('-of') + 1]}.txt`, 'Salut! Acesta este un test.');
    }
    return {};
  };
  const options = { tempDir: dir, download: async () => Readable.from([Buffer.from('synthetic audio')]), run: execute };
  assert.equal((await processMessageMedia(message, null, null, options)).extractedText, 'Salut! Acesta este un test.');
  assert.deepEqual(fs.readdirSync(dir), []);
  const long = await processMessageMedia(message, null, null, { ...options, run: async () => ({ stdout: '601' }) });
  assert.equal(long.error, 'audio_too_long');
  const huge = await processMessageMedia(message, null, null, { ...options, download: async () => Readable.from([Buffer.alloc(20 * 1024 * 1024 + 1)]) });
  assert.equal(huge.error, 'attachment_too_large');
  const failed = await processMessageMedia(message, null, null, { ...options, run: async () => { throw Object.assign(new Error('synthetic failure'), { code: 'TEST' }); } });
  assert.equal(failed.error, 'local_processing_failed');
  const controller = new AbortController();
  let lateDownload;
  const pending = processMessageMedia(message, null, null, { ...options, signal: controller.signal,
    download: () => new Promise((resolve) => { lateDownload = resolve; }) });
  while (!lateDownload) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  assert.equal((await pending).processed, false);
  const lateStream = Readable.from([Buffer.from('late audio')]);
  lateDownload(lateStream);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lateStream.destroyed, true);
  assert.equal(whisperCalls, 1);
  assert.deepEqual(fs.readdirSync(dir), []);
  const stale = fs.mkdtempSync(path.join(dir, 'threadmark-media-'));
  fs.writeFileSync(path.join(stale, 'input.ogg'), 'synthetic stale recording');
  fs.mkdirSync(path.join(dir, 'unrelated'));
  await cleanupMediaTemp(dir);
  assert.deepEqual(fs.readdirSync(dir), ['unrelated'], 'restart cleanup removes only known media staging');
});
