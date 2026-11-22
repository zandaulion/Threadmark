import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GmailConnector } from '../gmail/client.mjs';
import { senderSourceId } from '../gmail/normalize.mjs';
import { openDatabase, ThreadmarkStore } from '../app/server/store.mjs';
import { createThreadmarkServer } from '../app/server/server.mjs';
import { isIgnoredGmailMessage, isIgnoredGmailSender } from '../shared/gmail-filters.mjs';

test('GitHub exclusion matches sender domains rather than display names or mentions', () => {
  const settings = { ignoreGitHubEmails: true };
  for (const name of ['notifications@github.com', ' NOREPLY@GITHUB.COM ', 'alerts@updates.github.com', 'security@github.com']) {
    assert.equal(isIgnoredGmailSender(name, settings), true);
  }
  for (const name of ['GitHub', 'reviewer@example.test', 'notifications@github.com.example.test', 'notifications@fakegithub.com', '', null]) {
    assert.equal(isIgnoredGmailSender(name, settings), false);
  }
  assert.equal(isIgnoredGmailSender('notifications@github.com', {}), false);
  assert.equal(isIgnoredGmailMessage({ sourceKind: 'group', senderHints: { github: true } }, settings), false);
});

test('both Gmail profiles skip all GitHub bodies before delivery and continue their checkpoints', async () => {
  for (const profileId of ['personal', 'dev']) {
    let ignore = true;
    const fullFetches = [];
    const events = [];
    const secretStore = { available: () => true, load: () => ({ refreshToken: 'synthetic', accessToken: 'synthetic', accessTokenExpiresAt: '2099-01-01T00:00:00Z', historyId: '10' }), save: () => {} };
    const outbox = { put: (id, endpoint, payload) => events.push({ id, endpoint, payload }), close: () => {} };
    const source = { id: profileId === 'dev' ? 'gmail:dev:label:INBOX' : 'gmail:label:INBOX', kind: 'gmail_label', name: 'Inbox' };
    const message = (id, full) => ({ id, threadId: id, labelIds: ['INBOX'], internalDate: String(Date.now()), payload: {
      headers: [
        { name: 'From', value: `${id === 'bot' ? 'dependabot[bot]' : id === 'human' || id === 'other' ? 'Example Reviewer' : 'GitHub'} <${id === 'other' ? 'reviewer@example.test' : 'notifications@github.com'}>` },
        { name: 'Subject', value: id === 'human' ? 'Question about Dependabot' : 'Synthetic repository notification' },
      ], mimeType: 'text/plain', body: full ? { data: Buffer.from('Synthetic notification content.').toString('base64url') } : {},
    } });
    const connector = new GmailConnector({ profileId, appUrl: 'http://app', bridgeToken: 'synthetic' }, secretStore, outbox, { fetch: async (input) => {
      const url = new URL(input);
      if (url.pathname === '/internal/routing') return Response.json({ ignoreGitHubEmails: ignore, gmailSources: [source] });
      if (url.pathname.endsWith('/history')) return Response.json({ historyId: '11', history: [{ messagesAdded: ['bot', 'human', 'security', 'other'].map(id => ({ message: { id } })) }] });
      const id = url.pathname.split('/').at(-1);
      const full = url.searchParams.get('format') === 'full';
      if (full) fullFetches.push(id);
      return Response.json(message(id, full));
    } });
    await connector.refreshRouting();
    await connector.sync();
    assert.equal(connector.credentials.historyId, '11');
    assert.deepEqual(fullFetches, ['other']);
    assert.equal(events.filter(event => event.endpoint === '/internal/events').length, 1);
    assert.equal(events.some(event => event.payload.senderName === 'dependabot[bot]'), false);
    ignore = false;
    await connector.refreshRouting();
    await connector.processMessage('bot');
    assert.equal(fullFetches.at(-1), 'bot');
  }
});

test('existing GitHub alerts disappear reversibly from every feed, count and due queue', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'threadmark-mail-filter-'));
  const db = openDatabase(directory);
  try {
    const store = new ThreadmarkStore(db);
    for (const profileId of ['personal', 'dev']) {
      const source = { id: profileId === 'dev' ? 'gmail:dev:label:INBOX' : 'gmail:label:INBOX', name: 'Inbox', kind: 'gmail_label' };
      store.upsertGmailSources([source], profileId); store.selectGmailSource(source.id, true, profileId);
      store.upsertGmailSources([{ id: senderSourceId('alerts@updates.github.com', profileId), name: 'GitHub alerts · alerts@updates.github.com', kind: 'gmail_sender' }], profileId);
      for (const state of ['open', 'done', 'snoozed', 'promotional']) {
        const result = store.ingestMessage({ id: `${profileId}-${state}`, profileId, sourceId: source.id, sourceKind: source.kind, sourceName: source.name,
          senderId: senderSourceId(state === 'promotional' ? 'alerts@updates.github.com' : 'notifications@github.com', profileId), senderName: 'GitHub', text: 'Synthetic update', sentAt: new Date().toISOString() }, [{
          type: 'reminder', key: 'synthetic', title: 'Synthetic update', confidence: 0.9, amountMinor: null, currency: null,
          eventAt: new Date(Date.now() + 60_000).toISOString(), details: state === 'promotional' ? { attentionTriage: { disposition: 'promotional' } } : {},
        }], { includeLocal: false });
        if (state === 'done') store.setItemStatus(result.items[0].id, 'done');
        if (state === 'open') db.prepare('UPDATE attention_items SET snoozed_until=? WHERE id=?').run(new Date(Date.now() - 60_000).toISOString(), result.items[0].id);
        if (state === 'snoozed') store.snoozeItem(result.items[0].id, new Date(Date.now() + 3_600_000).toISOString());
      }
    }
    assert.equal(store.listItems({ profileId: 'dev', status: 'all' }).length, 4);
    assert.equal(store.dueNotifications().length, 2);
    store.updateSettings({ ...store.settings(), ignoreGitHubEmails: true });
    for (const profileId of ['personal', 'dev']) {
      for (const status of ['all', 'open', 'done', 'snoozed', 'promotional']) assert.deepEqual(store.listItems({ profileId, status }), []);
      const counts = store.summary(profileId);
      assert.deepEqual([counts.open, counts.snoozed, counts.promotional], [0, 0, 0]);
      assert.equal(store.routingConfig(profileId).ignoreGitHubEmails, true);
    }
    assert.deepEqual(store.dueNotifications(), []);
    assert.equal(store.ingestMessage({ id: 'blocked', sourceId: 'gmail:label:INBOX', sourceName: 'Inbox', sourceKind: 'gmail_label', senderId: senderSourceId('notifications@github.com'), senderName: 'dependabot[bot]', text: 'Please pay 20 RON.' }).reason, 'ignored_sender');
    assert.equal(store.hasMessage('blocked'), false);
    store.updateSettings({ ...store.settings(), ignoreGitHubEmails: false });
    assert.equal(store.listItems({ profileId: 'dev', status: 'all' }).length, 4);
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('queued GitHub events are rejected before Jev while outside senders can still mention GitHub', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadmark-bot-ingestion-'));
  let jevCalls = 0;
  const app = createThreadmarkServer({
    config: { dataDir, webDir: path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'app/web'), bridgeToken: 'b'.repeat(64), internalPort: 0 },
    push: { enabled: false, notifyItem: async () => {} },
    jev: { status: () => ({ enabled: true }), evaluate: async () => { jevCalls++; return { available: false, detections: [] }; } },
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  app.store.updateSettings({ ...app.store.settings(), ignoreGitHubEmails: true });
  app.store.upsertGmailSources([{ id: 'gmail:label:INBOX', kind: 'gmail_label', name: 'Inbox' }]);
  app.store.selectGmailSource('gmail:label:INBOX', true);
  const send = senderName => fetch(`http://127.0.0.1:${app.server.address().port}/internal/events`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-token': 'b'.repeat(64) },
    body: JSON.stringify({ id: senderName, sourceKind: 'gmail_label', sourceId: 'gmail:label:INBOX', sourceName: 'Inbox', senderName, senderId: senderSourceId(senderName === 'dependabot[bot]' ? 'notifications@github.com' : 'reviewer@example.test'), text: 'Please review our Dependabot configuration on GitHub.', sentAt: new Date().toISOString() }),
  }).then(response => response.json());
  assert.deepEqual(await send('dependabot[bot]'), { accepted: false, reason: 'ignored_sender' });
  assert.equal(jevCalls, 0);
  await send('Example Reviewer');
  assert.equal(jevCalls, 1);
});
