import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeContacts, normalizeMessage, resolveContactSourceId } from '../bridge/normalize.mjs';

test('normalizes incoming individual chat messages as contact sources', () => {
  const message = normalizeMessage({
    key: { id: 'abc123', remoteJid: '15550100001@s.whatsapp.net', fromMe: false },
    pushName: 'Demo Contact',
    messageTimestamp: 1_759_320_000,
    message: { conversation: 'Ne vedem mâine la 18:30.' },
  });
  assert.equal(message.sourceKind, 'contact');
  assert.equal(message.sourceId, '15550100001@s.whatsapp.net');
  assert.equal(message.sourceName, 'Demo Contact');
  assert.equal(message.senderId, message.sourceId);
});

test('resolves LID messages to the canonical phone contact', async () => {
  const lid = '15423915450450@lid';
  const sourceId = await resolveContactSourceId(lid, async (candidate) => {
    assert.equal(candidate, lid);
    return '15550100002:0@s.whatsapp.net';
  });
  assert.equal(sourceId, '15550100002@s.whatsapp.net');
  const message = normalizeMessage({
    key: { id: 'lid-message', remoteJid: lid, fromMe: false },
    pushName: 'Example User',
    messageTimestamp: 1_759_320_000,
    message: { conversation: 'test' },
  }, '', sourceId);
  assert.equal(message.sourceId, '15550100002@s.whatsapp.net');
  assert.equal(message.senderId, '15550100002@s.whatsapp.net');
});

test('keeps an unresolved LID isolated instead of guessing an identity', async () => {
  const lid = '123456789012345@lid';
  assert.equal(await resolveContactSourceId(lid, async () => null), lid);
});

test('still normalizes groups and rejects own or broadcast messages', () => {
  const group = normalizeMessage({
    key: { id: 'group1', remoteJid: '120363000000000000@g.us', participant: '15550100003@s.whatsapp.net', fromMe: false },
    pushName: 'Sample Sender',
    messageTimestamp: 1_759_320_000,
    message: { conversation: 'Plata este 25 lei.' },
  }, 'Parents');
  assert.equal(group.sourceKind, 'group');
  assert.equal(group.sourceName, 'Parents');
  assert.equal(normalizeMessage({ key: { id: 'own', remoteJid: '15550100001@s.whatsapp.net', fromMe: true } }), null);
  assert.equal(normalizeMessage({ key: { id: 'status', remoteJid: 'status@broadcast', fromMe: false } }), null);
});

test('normalizes outgoing text so reply tracking can be enabled explicitly', () => {
  const message = normalizeMessage({
    key: { id: 'own-text', remoteJid: '15550100001@s.whatsapp.net', fromMe: true },
    messageTimestamp: 1_759_320_000,
    message: { conversation: 'Confirmed, thank you.' },
  });
  assert.equal(message.direction, 'outgoing');
  assert.equal(message.senderName, 'You');
});

test('normalizes contact metadata from Baileys events', () => {
  assert.deepEqual(normalizeContacts([
    { id: '15550100001@s.whatsapp.net', notify: 'Demo Contact' },
    { id: 'status@broadcast', name: 'Status' },
  ]), [{ id: '15550100001@s.whatsapp.net', name: 'Demo Contact' }]);
  assert.deepEqual(normalizeContacts([{ id: '15550100004@s.whatsapp.net' }]), [
    { id: '15550100004@s.whatsapp.net', name: '+15550100004' },
  ]);
  assert.deepEqual(normalizeContacts([{ id: '123456789012345@lid' }]), []);
  assert.deepEqual(normalizeContacts([{ id: '123456789012345@lid', name: 'Demo Contact' }]), []);
  assert.deepEqual(normalizeContacts([{ id: '123456789012345@lid', phoneNumber: '15550100005@s.whatsapp.net', name: 'Sample Contact' }]), [
    { id: '15550100005@s.whatsapp.net', name: 'Sample Contact' },
  ]);
  assert.deepEqual(normalizeContacts([{ id: '123456789012345@lid', phoneNumber: '15550100005:0@s.whatsapp.net', name: 'Sample Contact' }]), [
    { id: '15550100005@s.whatsapp.net', name: 'Sample Contact' },
  ]);
});
