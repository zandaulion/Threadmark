import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GmailConnector } from '../gmail/client.mjs';
import { cleanEmailText, messageMetadata, normalizeGmailMessage, parseMailbox, senderSourceId } from '../gmail/normalize.mjs';
import { SecretStore } from '../gmail/secret-store.mjs';
import { openDatabase, ThreadmarkStore } from '../app/server/store.mjs';

test('normalizes Gmail text while removing quoted replies and preserving a Gmail deep link', () => {
  const source = { id: 'gmail:label:INBOX', name: 'Inbox', kind: 'gmail_label' };
  const message = {
    id: 'msg-1', threadId: 'thread-1', internalDate: '1790856000000',
    payload: {
      mimeType: 'multipart/alternative',
      headers: [{ name: 'From', value: 'Example Parent <parent@example.test>' }, { name: 'Subject', value: 'Permission form' }],
      parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('Please sign by Friday.\n\nOn Thu, Someone wrote:\n> old text').toString('base64url') } }],
    },
  };
  const normalized = normalizeGmailMessage(message, source);
  assert.equal(normalized.sourceKind, 'gmail_label');
  assert.equal(normalized.senderName, 'Example Parent');
  assert.equal(normalized.text, 'Permission form\n\nPlease sign by Friday.');
  assert.equal(normalized.externalUrl, 'https://mail.google.com/mail/u/0/#all/thread-1');
  assert.match(normalized.senderId, /^gmail:sender:[a-f0-9]{32}$/u);
  assert.equal(parseMailbox('person@example.test').address, 'person@example.test');
  assert.equal(cleanEmailText('New text\n-- \nSignature'), 'New text');
});

test('encrypted Gmail credential store never writes the refresh token in plaintext', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadmark-gmail-secret-'));
  try {
    const store = new SecretStore(dataDir, crypto.randomBytes(32).toString('base64url'));
    store.save({ refreshToken: 'private-refresh-token', email: 'owner@example.test' });
    const disk = fs.readFileSync(path.join(dataDir, 'gmail-credentials.enc'), 'utf8');
    assert.equal(disk.includes('private-refresh-token'), false);
    assert.equal(store.load().refreshToken, 'private-refresh-token');
    store.clear();
    assert.equal(store.load().refreshToken, undefined);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('Gmail connector fetches a full body only after metadata matches a selected source', async () => {
  const calls = [];
  const events = [];
  const secretStore = {
    available: () => true,
    load: () => ({ refreshToken: 'refresh', accessToken: 'access', accessTokenExpiresAt: '2099-01-01T00:00:00Z', email: 'owner@example.test', historyId: '10' }),
    save: () => {}, clear: () => {},
  };
  const outbox = { put: (id, endpoint, payload) => events.push({ id, endpoint, payload }), pending: () => [], delivered: () => {}, failed: () => {}, close: () => {} };
  const fakeFetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/history?')) return response({ historyId: '11', history: [{ messagesAdded: [{ message: { id: 'mail-1' } }] }] });
    if (String(url).includes('format=metadata')) return response({
      id: 'mail-1', threadId: 'thread-1', labelIds: ['INBOX'],
      payload: { headers: [{ name: 'From', value: 'Teacher <teacher@example.test>' }, { name: 'Subject', value: 'Homework' }] },
    });
    if (String(url).includes('format=full')) return response({
      id: 'mail-1', threadId: 'thread-1', internalDate: '1790856000000', labelIds: ['INBOX'],
      payload: { headers: [{ name: 'From', value: 'Teacher <teacher@example.test>' }, { name: 'Subject', value: 'Homework' }], mimeType: 'text/plain', body: { data: Buffer.from('Bring the signed page tomorrow.').toString('base64url') } },
    });
    throw new Error(`Unexpected request: ${url}`);
  };
  const connector = new GmailConnector({
    clientId: 'client', clientSecret: 'secret', redirectUri: 'https://threadmark.test/api/gmail/oauth/callback',
    appUrl: 'http://app', bridgeToken: 'token', pollSeconds: 60,
  }, secretStore, outbox, { fetch: fakeFetch });
  connector.routing.set('gmail:label:INBOX', { id: 'gmail:label:INBOX', name: 'Inbox', kind: 'gmail_label' });
  await connector.sync();
  assert.equal(calls.some((url) => url.includes('format=full')), true);
  assert.equal(events.some((event) => event.endpoint === '/internal/events' && event.payload.text.includes('signed page')), true);

  calls.length = 0;
  events.length = 0;
  connector.credentials.historyId = '11';
  connector.routing.clear();
  await connector.sync();
  assert.equal(calls.some((url) => url.includes('format=full')), false);
  assert.equal(events.some((event) => event.endpoint === '/internal/events'), false);
});

test('Gmail sources participate in the existing detector and inbox model', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadmark-gmail-store-'));
  const db = openDatabase(dataDir);
  try {
    const store = new ThreadmarkStore(db);
    const source = { id: 'gmail:label:Label_school', name: 'School', kind: 'gmail_label' };
    store.upsertGmailSources([source]);
    assert.equal(store.selectGmailSource(source.id, true), true);
    const result = store.ingestMessage({
      id: 'gmail:mail-2', sourceId: source.id, sourceName: source.name, sourceKind: source.kind,
      senderId: senderSourceId('school@example.test'), senderName: 'School office', sentAt: '2026-10-02T08:00:00Z',
      text: 'Please pay 75 lei by Friday.', externalUrl: 'https://mail.google.com/mail/u/0/#all/mail-2',
    });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].source.kind, 'gmail_label');
    assert.equal(result.items[0].externalUrl, 'https://mail.google.com/mail/u/0/#all/mail-2');
    assert.equal(store.summary().gmail, 1);
    assert.deepEqual(store.routingConfig().gmailSources.map((item) => ({ ...item })), [source]);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally { db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('sender metadata uses stable opaque source identifiers', () => {
  const metadata = messageMetadata({ id: 'x', labelIds: ['INBOX'], payload: { headers: [{ name: 'From', value: 'Name <name@example.test>' }] } });
  assert.equal(metadata.sender.address, 'name@example.test');
  assert.equal(metadata.senderSourceId, senderSourceId('NAME@example.test'));
  assert.equal(metadata.senderSourceId.includes('name@example.test'), false);
});

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}
