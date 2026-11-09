import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createThreadmarkServer } from '../app/server/server.mjs';
import { normalizeMessage } from '../bridge/normalize.mjs';

const group = { id: '120363000000000222@g.us', name: 'Demo group' };
const otherGroup = { id: '120363000000000333@g.us', name: 'Other demo group' };
const contact = { id: '15550100001@s.whatsapp.net', name: 'Demo contact' };
const timestamp = new Date(Date.now() - 60_000).toISOString();

test('outgoing quoted text and media carry only the original ID for reply matching', () => {
  for (const content of [
    { extendedTextMessage: { text: 'Confirmed', contextInfo: { stanzaId: 'original', quotedMessage: { conversation: 'Private quoted text' } } } },
    { audioMessage: { seconds: 2, mimetype: 'audio/ogg', contextInfo: { stanzaId: 'original' } } },
  ]) {
    const result = normalizeMessage({ key: { id: 'reply', remoteJid: group.id, fromMe: true }, messageTimestamp: Date.now() / 1000,
      message: { ephemeralMessage: { message: content } } }, group.name);
    assert.equal(result.quotedMessageId, 'original');
    assert.equal(JSON.stringify(result).includes('Private quoted text'), false);
  }
});

test('reply and Done dismiss only matching alerts, preserve obligations, and reject stale alert delivery', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadmark-reply-notifications-'));
  const dismissed = [];
  const app = createThreadmarkServer({ config: { dataDir: dir, cookieSecure: false, bridgeToken: 'b'.repeat(64), adminToken: 'a'.repeat(64),
    webDir: path.join(path.dirname(fileURLToPath(import.meta.url)), '../app/web') },
    push: { enabled: false, publicKey: '', notifyItem: async () => {}, dismissItems: async (payload) => { dismissed.push(payload); } },
    jev: { status: () => ({ enabled: false }), evaluate: async () => assert.fail('outgoing replies stay local') } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  app.store.upsertGroups([group, otherGroup]); app.store.upsertContacts([contact]);
  for (const g of [group, otherGroup]) app.store.selectGroup(g.id, true);
  app.store.selectContact(contact.id, true);
  app.store.updateSettings({ outgoingMonitoring: true });
  const add = (id, source, type = 'reminder', awaitingReply = true, sentAt = timestamp) => app.store.ingestMessage({
    id, sourceId: source.id, sourceKind: source === contact ? 'contact' : 'group', sourceName: source.name,
    senderName: 'Demo sender', sentAt, text: 'Synthetic attention item', direction: 'incoming',
  }, [{ type, key: 'fixture', title: 'Synthetic alert', details: { awaitingReply }, confidence: 1, notify: true,
    eventAt: null, amountMinor: null, currency: null }], { includeLocal: false }).items[0];
  const obligation = add('payment', group, 'payment', false);
  const pending = add('pending', group);
  const foreign = add('foreign', otherGroup);
  const direct = add('direct', contact);
  const future = add('future', contact, 'reminder', true, new Date(Date.now() + 3600_000).toISOString());
  const reply = (source, quotedMessageId, sentAt = new Date().toISOString(), media = null) => fetch(`${base}/internal/events`, { method: 'POST',
    headers: { 'x-bridge-token': 'b'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify({ id: 'synthetic-reply',
      sourceId: source.id, sourceName: source.name, sourceKind: source === contact ? 'contact' : 'group',
      sentAt, direction: 'outgoing', text: 'Confirmed', quotedMessageId, media }) });
  assert.equal((await reply(group)).status, 200);
  assert.equal(dismissed.length, 0, 'an unrelated group message dismisses nothing');
  await reply(group, 'foreign'); assert.equal(dismissed.length, 0, 'quoted IDs cannot cross sources');
  const repliedAt = new Date().toISOString();
  await reply(group, 'payment', repliedAt);
  assert.deepEqual(dismissed.at(-1).itemIds, [obligation.id]);
  assert.equal(app.store.itemById(obligation.id).status, 'open', 'replying does not pay a bill');
  assert.equal(app.store.itemById(pending.id).status, 'open');
  assert.equal(app.store.itemById(foreign.id).status, 'open');
  await reply(group, 'pending', new Date().toISOString(), { kind: 'audio' });
  assert.equal(app.store.itemById(pending.id).status, 'done', 'outgoing voice replies work without voice transcription');
  await reply(contact); assert.equal(app.store.itemById(direct.id).status, 'done');
  assert.equal(app.store.itemById(future.id).status, 'open', 'delayed replies do not complete newer messages');
  app.store.updateSettings({ outgoingMonitoring: false });
  const before = dismissed.length;
  await reply(group, 'foreign'); assert.equal(dismissed.length, before, 'outgoing monitoring remains opt-in');
  const invite = app.auth.createInvite('Synthetic browser');
  const redeemed = await fetch(`${base}/api/auth/redeem`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: invite.code, label: 'Synthetic browser' }) });
  const cookie = redeemed.headers.get('set-cookie').split(';')[0];
  const call = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await fetch(`${base}/api/notifications/state`, { method: 'POST' })).status, 401);
  const state = await call('/api/notifications/state', { alerts: [
    { itemId: obligation.id, issuedAt: timestamp }, { itemId: obligation.id, issuedAt: new Date(Date.now() + 1000).toISOString() },
    { itemId: pending.id }, { itemId: foreign.id },
  ] }).then((r) => r.json());
  assert.deepEqual(state.dismissedIds, [obligation.id, pending.id], 'old alerts are suppressed, a future deadline alert stays eligible');
  assert.equal((await call('/api/notifications/state', { alerts: [null] })).status, 400);
  assert.equal((await call(`/api/items/${encodeURIComponent(foreign.id)}/status`, { status: 'done' })).status, 200);
  assert.deepEqual(dismissed.at(-1).itemIds, [foreign.id]);
  assert.equal(app.store.itemById(foreign.id).status, 'done');
});
