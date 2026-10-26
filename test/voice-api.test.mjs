import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createThreadmarkServer } from '../app/server/server.mjs';

test('voice API authenticates, shows ordinary transcripts, retries failures, and gates JEV behind a separate opt-in', async (t) => {
  const sourceId = '15550100001@s.whatsapp.net';
  const note = { id: 'synthetic-voice', sourceId, sourceKind: 'contact', sourceName: 'Demo contact', senderName: 'Demo speaker',
    sentAt: new Date().toISOString(), direction: 'incoming', status: 'queued', attempt: 1 };
  const failed = { ...note, id: 'synthetic-failure', status: 'failed', error: 'local_processing_failed', retryUntil: new Date(Date.now() + 3600_000).toISOString() };
  let retries = 0;
  const bridge = http.createServer(async (req, res) => {
    assert.equal(req.headers['x-bridge-token'], 'b'.repeat(64));
    assert.equal(req.url, '/voice/retry');
    let body = ''; for await (const chunk of req) body += chunk;
    assert.equal(JSON.parse(body).id, failed.id);
    retries++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ...failed, status: 'queued', error: null, attempt: 2 }));
  });
  await new Promise((resolve) => bridge.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => bridge.close(resolve)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadmark-voice-api-'));
  let jevCalls = 0;
  let analysisSignals = {};
  let lastOptions;
  const app = createThreadmarkServer({ config: { dataDir: dir,
    webDir: path.join(path.dirname(fileURLToPath(import.meta.url)), '../app/web'), cookieSecure: false,
    bridgeToken: 'b'.repeat(64), adminToken: 'a'.repeat(64), bridgeControlUrl: `http://127.0.0.1:${bridge.address().port}` },
    jev: { status: () => ({ enabled: true }), evaluate: async (_, __, options) => { jevCalls++; lastOptions = options; return { available: true, detections: [], signals: analysisSignals, scores: {} }; } },
    push: { enabled: false, publicKey: '', notifyItem: async () => {} } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const invite = app.auth.createInvite('Synthetic browser');
  const registration = await fetch(`${base}/api/auth/redeem`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: invite.code, label: 'Synthetic browser' }) });
  const cookie = registration.headers.get('set-cookie').split(';')[0];
  const call = (url, body, internal = false) => fetch(`${base}${url}`, { method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(internal ? { 'x-bridge-token': 'b'.repeat(64) } : { cookie }) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  app.store.upsertContacts([{ id: sourceId, name: 'Demo contact' }]);
  app.store.selectContact(sourceId, true);
  assert.equal((await fetch(`${base}/api/voice-notes`)).status, 401);
  assert.equal((await call('/internal/voice-notes', note)).status, 404);
  assert.equal((await call('/internal/voice-notes', note, true).then((r) => r.json())).accepted, false);
  const preferences = async (settings) => fetch(`${base}/api/settings`, { method: 'PUT',
    headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(settings) });
  await preferences({ voiceTranscription: true });
  assert.equal((await call('/internal/voice-notes', note, true).then((r) => r.json())).accepted, true);
  const ready = { ...note, status: 'ready', transcript: 'Mulțumesc, o zi frumoasă!' };
  await call('/internal/voice-notes', ready, true);
  const notes = await call('/api/voice-notes').then((r) => r.json());
  assert.equal(notes.notes.length, 1);
  assert.equal(notes.notes[0].transcript, ready.transcript);
  assert.equal((await call('/api/feed').then((r) => r.json())).items.length, 0);
  assert.deepEqual((await call('/api/voice-notes?profile=dev').then((r) => r.json())).notes, []);
  assert.equal(jevCalls, 0);
  const action = { ...note, origin: 'voice_transcript', voiceAttempt: 1, text: ready.transcript, media: { kind: 'audio', processed: true, processor: 'whisper' } };
  assert.equal((await call('/internal/events', action, true).then((r) => r.json())).reason, 'voice_actions_disabled');
  assert.equal(jevCalls, 0);
  await call('/internal/events', { ...action, media: null }, true);
  assert.equal(jevCalls, 0, 'the origin gate also protects a transcript with missing media metadata');
  await preferences({ voiceTranscription: true, voiceActionDetection: true, contextAware: true, outgoingMonitoring: true });
  await call('/internal/events', { ...action, voiceAttempt: 2 }, true);
  assert.equal(jevCalls, 0, 'an unrecognized or stale transcript cannot enter inference');
  const newer = { ...note, id: 'newer-typed-message', sentAt: new Date(Date.now() + 1000).toISOString(), text: 'Plata este 50 lei.' };
  const prior = app.store.ingestMessage(newer).items[0];
  assert.ok(prior);
  app.store.recordContextMessage(newer);
  analysisSignals = { cancelsPrevious: 0.99, changesPrevious: 0.99, replyNeeded: 0.99 };
  await call('/internal/events', action, true);
  assert.equal(jevCalls, 1);
  assert.deepEqual(lastOptions.context, []);
  assert.equal(lastOptions.contextAware, false);
  assert.equal(lastOptions.replyNeeded, false);
  assert.equal(app.store.itemById(prior.id).status, 'open', 'delayed speech cannot cancel a newer typed item');
  assert.equal(app.store.listItems({ type: 'reminder' }).length, 0, 'delayed speech does not create an awaiting-reply reminder');
  await call('/internal/voice-notes', failed, true);
  assert.equal((await call(`/api/voice-notes/${failed.id}/retry?profile=dev`, {})).status, 404);
  assert.equal((await call(`/api/voice-notes/${failed.id}/retry`, {})).status, 200);
  assert.equal(retries, 1);
  assert.equal((await call(`/api/voice-notes/${failed.id}/retry`, {})).status, 409, 'a queued retry cannot be queued twice');
  assert.equal(retries, 1);
  await preferences({ voiceTranscription: false });
  await call('/internal/voice-notes', { ...failed, attempt: 2, status: 'ready', transcript: 'Late result' }, true);
  const afterDisable = (await call('/api/voice-notes').then((r) => r.json())).notes;
  assert.equal(afterDisable.find((row) => row.id === failed.id).error, 'disabled');
  assert.equal(afterDisable.find((row) => row.id === failed.id).transcript, '');
  assert.equal(afterDisable.find((row) => row.id === note.id).transcript, ready.transcript, 'existing transcripts follow retention');
});
