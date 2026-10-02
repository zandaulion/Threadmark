import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createThreadmarkServer } from '../app/server/server.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('invite, group selection, bridge ingestion and resolution work together', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadmark-server-'));
  let jevCalls = 0;
  const jev = {
    status: () => ({ enabled: true, provider: 'TypeSafe AI', model: 'jev-test', threshold: 0.78 }),
    async detect(message, monitors = []) {
      jevCalls += 1;
      if (monitors.length) return [{
        type: monitors[0].category, key: `jev-monitor-${monitors[0].id}`, title: monitors[0].name, confidence: 0.91,
        priority: 0.93, amountMinor: null, currency: null, eventAt: null, notify: monitors[0].notify,
        details: { detector: 'jev', monitorId: monitors[0].id, model: 'jev-test', probability: 0.91, threshold: monitors[0].threshold },
      }];
      return [{
        type: 'reminder', key: 'jev-reminder', title: 'Action or deadline mentioned', confidence: 0.9,
        priority: 0.89, amountMinor: null, currency: null, eventAt: null, notify: true,
        details: { detector: 'jev', model: 'jev-test', scores: { payment: 0.1, meeting: 0.2, reminder: 0.9 } },
      }];
    },
    async evaluate(text, monitors = [], options = {}) {
      jevCalls += 1;
      const detections = monitors.length ? [{
        type: monitors[0].category, key: `jev-monitor-${monitors[0].id}`, title: monitors[0].name, confidence: 0.91,
        priority: 0.93, amountMinor: null, currency: null, eventAt: null, notify: monitors[0].notify,
        details: { detector: 'jev', monitorId: monitors[0].id, model: 'jev-test', probability: 0.91, threshold: monitors[0].threshold },
      }] : options.includeBuiltIns === false ? [] : [{
        type: 'reminder', key: 'jev-reminder', title: 'Action or deadline mentioned', confidence: 0.9,
        priority: 0.89, amountMinor: null, currency: null, eventAt: null, notify: true,
        details: { detector: 'jev', model: 'jev-test', scores: { payment: 0.1, meeting: 0.2, reminder: 0.9 } },
      }];
      return { ...this.status(), available: true, scores: {}, signals: {}, detections };
    },
    async evaluateMonitor(text, monitor) {
      return { ...this.status(), available: true, matched: text.includes('confirm'), probability: 0.91, threshold: monitor.threshold, detections: [] };
    },
  };
  const app = createThreadmarkServer({
    config: {
      dataDir,
      webDir: path.join(root, 'app/web'),
      adminToken: 'a'.repeat(64),
      bridgeToken: 'b'.repeat(64),
      publicBaseUrl: 'https://threadmark.test',
      cookieSecure: false,
      bridgeControlUrl: 'http://127.0.0.1:1',
    },
    push: { enabled: false, publicKey: '', notifyItem: async () => {} },
    jev,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const inviteResponse = await fetch(`${base}/api/admin/invites`, {
    method: 'POST', headers: { 'x-admin-token': 'a'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify({ label: 'Test phone' }),
  });
  assert.equal(inviteResponse.status, 201);
  const invite = await inviteResponse.json();
  const redeemResponse = await fetch(`${base}/api/auth/redeem`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: invite.code, label: 'Test phone' }),
  });
  assert.equal(redeemResponse.status, 200);
  const cookie = redeemResponse.headers.get('set-cookie').split(';')[0];

  const groupId = '120363000000000000@g.us';
  const groupsResponse = await fetch(`${base}/internal/groups`, {
    method: 'POST', headers: { 'x-bridge-token': 'b'.repeat(64), 'content-type': 'application/json' },
    body: JSON.stringify({ groups: [{ id: groupId, name: 'Parents', participantCount: 24 }] }),
  });
  assert.equal(groupsResponse.status, 200);
  const selectResponse = await fetch(`${base}/api/groups/${encodeURIComponent(groupId)}/selection`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ selected: true }),
  });
  assert.equal(selectResponse.status, 200);

  const eventResponse = await fetch(`${base}/internal/events`, {
    method: 'POST', headers: { 'x-bridge-token': 'b'.repeat(64), 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'wamid-1', groupId, groupName: 'Parents', senderId: '15550100003@s.whatsapp.net', senderName: 'Sample Sender', sentAt: '2026-10-01T12:00:00Z', text: 'Plata este 75 lei în contul RO00TEST0000000000000000.' }),
  });
  assert.equal(eventResponse.status, 200);
  const event = await eventResponse.json();
  assert.equal(event.items.length, 1);
  assert.equal(jevCalls, 0, 'local detections must not send text to Jev');

  const feed = await fetch(`${base}/api/feed`, { headers: { cookie } }).then((response) => response.json());
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].amountMinor, 7500);
  assert.equal(feed.items[0].detectionSource, 'rule');
  const resolveResponse = await fetch(`${base}/api/items/${encodeURIComponent(feed.items[0].id)}/status`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'done' }),
  });
  assert.equal(resolveResponse.status, 200);
  const summary = await fetch(`${base}/api/summary`, { headers: { cookie } }).then((response) => response.json());
  assert.equal(summary.open, 0);

  const jevStatus = await fetch(`${base}/api/detection/status`, { headers: { cookie } }).then((response) => response.json());
  assert.equal(jevStatus.enabled, true);
  const semanticEvent = await fetch(`${base}/internal/events`, {
    method: 'POST', headers: { 'x-bridge-token': 'b'.repeat(64), 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'wamid-jev', groupId, groupName: 'Parents', senderId: '15550100003@s.whatsapp.net', senderName: 'Sample Sender', sentAt: '2026-10-01T12:30:00Z', text: 'Vă rog să aduceți acordul semnat.' }),
  }).then((response) => response.json());
  assert.equal(jevCalls, 1);
  assert.equal(semanticEvent.items[0].type, 'reminder');
  assert.equal(semanticEvent.items[0].details.detector, 'jev');
  assert.equal(semanticEvent.items[0].detectionSource, 'jev');
  assert.equal(semanticEvent.items[0].priority, 0.89);

  const ruleResponse = await fetch(`${base}/api/rules`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Permission form', terms: ['formular'], category: 'reminder', matchMode: 'any', scope: 'all', notify: false }),
  });
  assert.equal(ruleResponse.status, 201);
  const rule = await ruleResponse.json();
  const testResponse = await fetch(`${base}/api/rules/test`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ rule, text: 'Nu uitați formularul pentru excursie.' }),
  }).then((response) => response.json());
  assert.equal(testResponse.matched, true);
  const ruleEvent = await fetch(`${base}/internal/events`, {
    method: 'POST', headers: { 'x-bridge-token': 'b'.repeat(64), 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'wamid-rule', groupId, groupName: 'Parents', senderId: '15550100003@s.whatsapp.net', senderName: 'Sample Sender', sentAt: '2026-10-01T13:00:00Z', text: 'Nu uitați formularul pentru excursie.' }),
  }).then((response) => response.json());
  assert.equal(ruleEvent.items[0].type, 'reminder');
  assert.equal(ruleEvent.items[0].notify, false);
  const disableRule = await fetch(`${base}/api/rules/${rule.id}/enabled`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }),
  });
  assert.equal(disableRule.status, 200);

  const semanticResponse = await fetch(`${base}/api/rules`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Decision needed', kind: 'semantic', condition: 'Someone needs a decision or confirmation from me.',
      category: 'reminder', threshold: 0.81, scope: 'all', notify: true,
    }),
  });
  assert.equal(semanticResponse.status, 201);
  const semanticRule = await semanticResponse.json();
  assert.equal(semanticRule.kind, 'semantic');
  const semanticTest = await fetch(`${base}/api/rules/test`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ rule: semanticRule, text: 'Can you confirm the transport option?' }),
  }).then((response) => response.json());
  assert.equal(semanticTest.matched, true);
  assert.equal(semanticTest.probability, 0.91);
  const semanticRuleEvent = await fetch(`${base}/internal/events`, {
    method: 'POST', headers: { 'x-bridge-token': 'b'.repeat(64), 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'wamid-semantic-rule', groupId, groupName: 'Parents', senderId: '15550100003@s.whatsapp.net', senderName: 'Sample Sender', sentAt: '2026-10-01T13:30:00Z', text: 'Which transport option do you choose?' }),
  }).then((response) => response.json());
  assert.equal(jevCalls, 2);
  assert.equal(semanticRuleEvent.items[0].title, 'Decision needed');
  assert.equal(semanticRuleEvent.items[0].details.monitorId, semanticRule.id);
  assert.equal(semanticRuleEvent.items[0].priority, 0.93);
});

test('concrete invoices are detected locally for WhatsApp and Gmail', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadmark-invoices-'));
  let jevCalls = 0;
  const jev = {
    status: () => ({ enabled: true, provider: 'TypeSafe AI', model: 'jev-test', threshold: 0.78, invoiceThreshold: 0.68 }),
    async evaluate() { jevCalls += 1; return { available: true, scores: {}, signals: {}, detections: [] }; },
  };
  const app = createThreadmarkServer({
    config: {
      dataDir,
      webDir: path.join(root, 'app/web'),
      adminToken: '1'.repeat(64),
      bridgeToken: '2'.repeat(64),
      publicBaseUrl: 'https://threadmark.test',
      cookieSecure: false,
    },
    push: { enabled: false, publicKey: '', notifyItem: async () => {} },
    jev,
  });
  const contact = { id: '15550100005@s.whatsapp.net', name: 'Household', kind: 'contact' };
  const gmailSource = { id: 'gmail:label:INBOX', name: 'Inbox', kind: 'gmail_label' };
  app.store.upsertContacts([contact]);
  app.store.selectContact(contact.id, true);
  app.store.upsertGmailSources([gmailSource]);
  app.store.selectGmailSource(gmailSource.id, true);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const headers = { 'x-bridge-token': '2'.repeat(64), 'content-type': 'application/json' };

  const whatsapp = await fetch(`${base}/internal/events`, {
    method: 'POST', headers,
    body: JSON.stringify({
      id: 'whatsapp-invoice', sourceId: contact.id, sourceName: contact.name, sourceKind: contact.kind,
      senderId: contact.id, senderName: contact.name, sentAt: '2026-10-02T12:00:00Z',
      text: 'Factura de gaze naturale este disponibilă în contul tău.',
    }),
  }).then((response) => response.json());
  const gmail = await fetch(`${base}/internal/events`, {
    method: 'POST', headers,
    body: JSON.stringify({
      id: 'gmail:invoice', sourceId: gmailSource.id, sourceName: gmailSource.name, sourceKind: gmailSource.kind,
      senderId: 'gmail:sender:example', senderName: 'Utility', sentAt: '2026-10-02T12:01:00Z',
      text: 'Your new electricity invoice is ready. View it in your account.',
    }),
  }).then((response) => response.json());

  for (const result of [whatsapp, gmail]) {
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].type, 'payment');
    assert.equal(result.items[0].title, 'Invoice needs attention');
    assert.equal(result.items[0].details.invoice, true);
    assert.equal(result.items[0].notify, true);
    assert.equal(result.items[0].detectionSource, 'rule');
  }
  assert.equal(jevCalls, 0, 'strong local invoice signals must remain on the server');

  const newsletter = await fetch(`${base}/internal/events`, {
    method: 'POST', headers,
    body: JSON.stringify({
      id: 'gmail:newsletter', sourceId: gmailSource.id, sourceName: gmailSource.name, sourceKind: gmailSource.kind,
      senderId: 'gmail:sender:newsletter', senderName: 'Newsletter', sentAt: '2026-10-02T12:02:00Z',
      text: `A profile mentions a business bill and an unusual loophole.${' The story continues without asking the reader to pay.'.repeat(12)} She only needed an internet connection to work abroad.`,
    }),
  }).then((response) => response.json());
  assert.deepEqual(newsletter.items, []);
  assert.equal(jevCalls, 1, 'ambiguous long-form invoice candidates must fall through to Jev');
});

test('Gmail local meeting matches require Jev confirmation and fail open when Jev is unavailable', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadmark-gmail-verification-'));
  const calls = [];
  const jev = {
    status: () => ({ enabled: true, provider: 'TypeSafe AI', model: 'jev-test', threshold: 0.78 }),
    async evaluate(text, monitors, options) {
      calls.push({ text, monitors, options });
      if (text.includes('product call')) {
        return { ...this.status(), available: true, scores: { payment: 0.1, meeting: 0.04, reminder: 0.08 }, signals: {}, detections: [] };
      }
      if (text.includes('appointment')) {
        return {
          ...this.status(), available: true, scores: { payment: 0.02, meeting: 0.95, reminder: 0.06 }, signals: {},
          detections: [{
            type: 'meeting', key: 'jev-meeting', title: 'Meeting or appointment mentioned', confidence: 0.95,
            priority: 0.1, amountMinor: null, currency: null, eventAt: null, notify: true,
            details: { detector: 'jev', model: 'jev-test' },
          }],
        };
      }
      return { ...this.status(), available: false, error: 'jev_unavailable', scores: {}, signals: {}, detections: [] };
    },
  };
  const app = createThreadmarkServer({
    config: {
      dataDir,
      webDir: path.join(root, 'app/web'),
      adminToken: 'e'.repeat(64),
      bridgeToken: 'f'.repeat(64),
      publicBaseUrl: 'https://threadmark.test',
      cookieSecure: false,
    },
    push: { enabled: false, publicKey: '', notifyItem: async () => {} },
    jev,
  });
  const source = { id: 'gmail:label:INBOX', name: 'Inbox', kind: 'gmail_label' };
  app.store.upsertGmailSources([source]);
  app.store.selectGmailSource(source.id, true);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const headers = { 'x-bridge-token': 'f'.repeat(64), 'content-type': 'application/json' };
  const send = (id, text) => fetch(`${base}/internal/events`, {
    method: 'POST', headers,
    body: JSON.stringify({
      id, sourceId: source.id, sourceName: source.name, sourceKind: source.kind,
      senderId: 'gmail:sender:example', senderName: 'Example sender', sentAt: '2026-10-02T12:00:00Z', text,
    }),
  }).then((response) => response.json());

  const rejected = await send('gmail:marketing', 'Join our product call tomorrow to learn what is new.');
  assert.deepEqual(rejected.items, []);

  const confirmed = await send('gmail:confirmed', 'Your appointment is tomorrow at 18:30.');
  assert.equal(confirmed.items.length, 1, 'the Jev meeting result must not duplicate the confirmed local item');
  assert.equal(confirmed.items[0].type, 'meeting');
  assert.equal(confirmed.items[0].detectionSource, 'rule');
  assert.deepEqual(confirmed.items[0].details.verification, {
    detector: 'jev', model: 'jev-test', probability: 0.95, threshold: 0.78,
  });

  const failOpen = await send('gmail:unavailable', 'Meeting tomorrow at 19:00.');
  assert.equal(failOpen.items.length, 1);
  assert.equal(failOpen.items[0].type, 'meeting');
  assert.equal(failOpen.items[0].details.verification, undefined);
  assert.equal(calls.length, 3);
  assert.equal(calls.every((call) => call.options.includeBuiltIns === true), true);
});

test('individual contacts are discovered but ignored until explicitly selected', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadmark-contact-'));
  const bridge = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.headers['x-bridge-token'] !== 'd'.repeat(64)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/contact-lookup') {
      res.end(JSON.stringify({ contact: { id: '15550100004@s.whatsapp.net', name: '+15550100004' } }));
      return;
    }
    if (req.url === '/contacts-lookup') {
      res.end(JSON.stringify({ contacts: [{ id: '15550100005@s.whatsapp.net', name: '+15550100005' }] }));
      return;
    }
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise((resolve) => bridge.listen(0, '127.0.0.1', resolve));
  const app = createThreadmarkServer({
    config: {
      dataDir,
      webDir: path.join(root, 'app/web'),
      adminToken: 'c'.repeat(64),
      bridgeToken: 'd'.repeat(64),
      publicBaseUrl: 'https://threadmark.test',
      cookieSecure: false,
      bridgeControlUrl: `http://127.0.0.1:${bridge.address().port}`,
    },
    push: { enabled: false, publicKey: '', notifyItem: async () => {} },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await app.close();
    await new Promise((resolve) => bridge.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const adminHeaders = { 'x-admin-token': 'c'.repeat(64), 'content-type': 'application/json' };
  const bridgeHeaders = { 'x-bridge-token': 'd'.repeat(64), 'content-type': 'application/json' };

  const invite = await fetch(`${base}/api/admin/invites`, {
    method: 'POST', headers: adminHeaders, body: JSON.stringify({ label: 'Contact test' }),
  }).then((response) => response.json());
  const redeemResponse = await fetch(`${base}/api/auth/redeem`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: invite.code, label: 'Contact test' }),
  });
  const cookie = redeemResponse.headers.get('set-cookie').split(';')[0];
  const contactId = '15550100001@s.whatsapp.net';

  const discovered = await fetch(`${base}/internal/contacts`, {
    method: 'POST', headers: bridgeHeaders, body: JSON.stringify({ contacts: [{ id: contactId, name: 'Demo Contact' }] }),
  });
  assert.equal(discovered.status, 200);

  const ignoredResponse = await fetch(`${base}/internal/events`, {
    method: 'POST', headers: bridgeHeaders,
    body: JSON.stringify({ id: 'direct-ignored', sourceId: contactId, sourceName: 'Demo Contact', sourceKind: 'contact', senderId: contactId, senderName: 'Demo Contact', sentAt: '2026-10-01T12:00:00Z', text: 'Plata este 50 lei.' }),
  });
  assert.deepEqual(await ignoredResponse.json(), { accepted: false, reason: 'not_selected', sourceKind: 'contact' });

  const contacts = await fetch(`${base}/api/contacts`, { headers: { cookie } }).then((response) => response.json());
  assert.equal(contacts.contacts.length, 1);
  assert.equal(contacts.contacts[0].selected, false);
  const selectResponse = await fetch(`${base}/api/contacts/${encodeURIComponent(contactId)}/selection`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ selected: true }),
  });
  assert.equal(selectResponse.status, 200);

  const eventResponse = await fetch(`${base}/internal/events`, {
    method: 'POST', headers: bridgeHeaders,
    body: JSON.stringify({ id: 'direct-meeting', sourceId: contactId, sourceName: 'Demo Contact', sourceKind: 'contact', senderId: contactId, senderName: 'Demo Contact', sentAt: '2026-10-01T12:00:00Z', text: 'Ne vedem mâine la 18:30.' }),
  });
  const event = await eventResponse.json();
  assert.equal(event.items.length, 1);
  assert.equal(event.items[0].source.kind, 'contact');
  assert.equal(event.items[0].source.name, 'Demo Contact');
  const feed = await fetch(`${base}/api/feed`, { headers: { cookie } }).then((response) => response.json());
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].group.kind, 'contact');

  const imageResponse = await fetch(`${base}/internal/events`, {
    method: 'POST', headers: bridgeHeaders,
    body: JSON.stringify({
      id: 'direct-handwritten-image', sourceId: contactId, sourceName: 'Demo Contact', sourceKind: 'contact',
      senderId: contactId, senderName: 'Demo Contact', sentAt: '2026-10-01T12:05:00Z', text: '[Attachment]',
      media: { kind: 'image', mimeType: 'image/jpeg', processed: false, error: 'no_text_found' },
    }),
  }).then((response) => response.json());
  assert.equal(imageResponse.items.length, 1);
  assert.equal(imageResponse.items[0].title, 'Photo needs review');
  assert.equal(imageResponse.items[0].details.needsReview, true);
  assert.equal(imageResponse.items[0].detectionSource, 'review');
  assert.equal(imageResponse.items[0].notify, true);

  const lookupResponse = await fetch(`${base}/api/contacts/lookup`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ phoneNumber: '+1 555 010 0004' }),
  });
  assert.equal(lookupResponse.status, 200);
  const afterLookup = await fetch(`${base}/api/contacts`, { headers: { cookie } }).then((response) => response.json());
  assert.equal(afterLookup.contacts.length, 2);
  assert.equal(afterLookup.contacts.find((contact) => contact.id === '15550100004@s.whatsapp.net').selected, false);

  const importResponse = await fetch(`${base}/api/contacts/import`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ contacts: [{ phoneNumber: '+1 555 010 0005', name: 'Sample Contact' }] }),
  });
  assert.equal(importResponse.status, 200);
  const imported = await importResponse.json();
  assert.equal(imported.contacts[0].name, 'Sample Contact');
  const afterImport = await fetch(`${base}/api/contacts`, { headers: { cookie } }).then((response) => response.json());
  assert.equal(afterImport.contacts.find((contact) => contact.id === '15550100005@s.whatsapp.net').name, 'Sample Contact');
});
