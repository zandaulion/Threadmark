import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeMessage } from '../bridge/normalize.mjs';
import { isInformationalReceipt } from '../app/server/detectors.mjs';
import { createThreadmarkServer } from '../app/server/server.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const group = { id: '120363000000000444@g.us', name: 'Synthetic parents', kind: 'group' };
const contact = { id: '15550100009@s.whatsapp.net', name: 'Synthetic contact', kind: 'contact' };
const self = ['15550100000:7@s.whatsapp.net', '99000000000001@lid'];

const groupMessage = (message) => ({
  key: { id: `g-${Math.random()}`, remoteJid: group.id, participant: '15550100005@s.whatsapp.net', fromMe: false },
  pushName: 'Parent', messageTimestamp: 1_759_320_000, message,
});

test('group messages report whether they mention or quote the user', () => {
  const mention = normalizeMessage(groupMessage({ extendedTextMessage: {
    text: '@99000000000001 poți confirma?', contextInfo: { mentionedJid: ['99000000000001@lid'] },
  } }), group.name, '', self);
  assert.equal(mention.addressedToMe, true);
  const quote = normalizeMessage(groupMessage({ extendedTextMessage: {
    text: 'Da, mulțumesc', contextInfo: { participant: '15550100000@s.whatsapp.net', quotedMessage: { conversation: 'Mâine?' } },
  } }), group.name, '', self);
  assert.equal(quote.addressedToMe, true);
  const other = normalizeMessage(groupMessage({ extendedTextMessage: {
    text: 'Mâine se țin cursurile?', contextInfo: { mentionedJid: ['15550100006@s.whatsapp.net'] },
  } }), group.name, '', self);
  assert.equal(other.addressedToMe, false);
  assert.equal(normalizeMessage(groupMessage({ conversation: 'Mâine?' }), group.name, '', self).addressedToMe, false);
  assert.equal('addressedToMe' in normalizeMessage(groupMessage({ conversation: 'Mâine?' }), group.name), false, 'unknown when own IDs are missing');
  const direct = normalizeMessage({
    key: { id: 'c1', remoteJid: contact.id, fromMe: false }, pushName: 'C', messageTimestamp: 1_759_320_000,
    message: { conversation: 'Vii mâine?' },
  }, '', '', self);
  assert.equal('addressedToMe' in direct, false, 'individual chats are always addressed to the user');
});

test('reports of a payment already made are informational', () => {
  for (const text of [
    'Buna ziua, am transferat pentru Ana Pop in contul ing. Multumim!',
    'Transferat pt Ion Pop pe ing. Multumesc',
    'Transferat ING pentru ANA POP și IOANA POP',
    'Buna ziua, transfer Revolut pentru Ana Pop',
    'Bună ziua. Transfer pe revolut pt Ana Pop. Mulțumim.',
    'Buna! Am am transferat in ING 200 pt Ana si Ioana Pop',
    'Buna ziua, din greseala am transferat de 2 ori pentru Ana Pop',
    'Bun\u0103 ziua, am transferat pentru Ana Pop'.normalize('NFD'),
  ]) assert.equal(isInformationalReceipt(text), true, text);
  for (const text of [
    'Bună ziua! Eu nu am reușit sa fac transfer, am încercat de 3 ori',
    'Am transferat, dar vă rog să achitați și diferența de 20 lei până vineri',
    'Pentru cotizația de 190 Ron puteti face plata in contul de mai jos.',
  ]) assert.equal(isInformationalReceipt(text), false, text);
});

test('WhatsApp relevance: payment reports, group replies and promotions', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadmark-wa-relevance-'));
  const calls = [];
  const jev = {
    status: () => ({ enabled: true, provider: 'TypeSafe AI', model: 'jev-test', threshold: 0.78 }),
    async evaluate(text, monitors = [], options = {}) {
      calls.push({ text, options });
      const promo = text.startsWith('Atelier');
      const detections = promo && options.includeBuiltIns !== false ? [{
        type: 'payment', key: 'jev-payment', title: 'Payment may need attention', confidence: 0.87, priority: 0.2,
        amountMinor: null, currency: null, eventAt: null, notify: true, details: { detector: 'jev', model: 'jev-test' },
      }] : [];
      return {
        ...this.status(), available: true, detections, scores: { payment: promo ? 0.87 : 0.1 },
        signals: {
          replyNeeded: text.endsWith('?') ? 0.95 : 0.1,
          promotional: promo ? 0.98 : 0.03,
          personalObligation: text.includes('obligatoriu') ? 0.4 : 0.05,
          transactional: 0.05, recipientSpecific: 0.05,
        },
      };
    },
  };
  const app = createThreadmarkServer({
    config: { dataDir, webDir: path.join(root, 'app/web'), adminToken: '7'.repeat(64), bridgeToken: '8'.repeat(64), cookieSecure: false },
    push: { enabled: false, publicKey: '', notifyItem: async () => {} }, jev,
  });
  app.store.upsertGroups([{ id: group.id, name: group.name, participantCount: 20 }]); app.store.selectGroup(group.id, true);
  app.store.upsertContacts([{ id: contact.id, name: contact.name }]); app.store.selectContact(contact.id, true);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let sequence = 0;
  const send = (text, source = group, extra = {}) => fetch(`${base}/internal/events`, {
    method: 'POST', headers: { 'x-bridge-token': '8'.repeat(64), 'content-type': 'application/json' },
    body: JSON.stringify({ id: `wa-relevance-${++sequence}`, sourceId: source.id, sourceName: source.name, sourceKind: source.kind,
      senderId: 'synthetic-sender', senderName: 'Synthetic sender', sentAt: new Date().toISOString(), direction: 'incoming', text, ...extra }),
  }).then((response) => response.json());

  const report = await send('Transferat ING pentru ANA POP');
  assert.deepEqual(report.items, [], 'a payment report is not an attention item');
  assert.ok(calls.every((call) => !call.text.startsWith('Transferat') || call.options.includeBuiltIns === false),
    'payment reports never ask Jev for built-in detections');

  assert.deepEqual((await send('Mâine se țin cursurile?', group, { addressedToMe: false })).items, []);
  const family = { id: '120363000000000555@g.us', name: 'Synthetic family', kind: 'group' };
  app.store.upsertGroups([{ id: family.id, name: family.name, participantCount: 3 }]); app.store.selectGroup(family.id, true);
  const small = await send('Ai ajuns acasă?', family, { addressedToMe: false });
  assert.equal(small.items[0]?.title, 'Reply requested', 'small groups behave like private chats');
  const mentioned = await send('Poți confirma tu?', group, { addressedToMe: true });
  assert.equal(mentioned.items[0]?.title, 'Reply requested');
  const legacy = await send('Ajungi la timp?', group);
  assert.equal(legacy.items[0]?.title, 'Reply requested', 'events without addressing keep the old behaviour');
  const direct = await send('Vii mâine?', contact);
  assert.equal(direct.items[0]?.title, 'Reply requested');

  const promotion = await send('Atelier de povești pentru copii în weekend, 80 lei de copil.');
  assert.equal(promotion.items[0].details.attentionTriage.disposition, 'promotional');
  assert.equal(promotion.items[0].notify, false);
  const obligation = await send('Atelier obligatoriu pentru grupă, 80 lei de copil.');
  assert.equal(obligation.items[0].details.attentionTriage.disposition, undefined, 'a promotion with real obligation stays');
});

test('group messages report when they open by addressing someone else', () => {
  const opening = (text, selfName = 'Alex Pop') => normalizeMessage(groupMessage({ conversation: text }), group.name, '', self, selfName);
  assert.equal(opening('Bună Maria, pune și o poză te rog.').addressedToOther, true);
  assert.equal(opening('Maria, poți trimite lista?').addressedToOther, true);
  assert.equal(opening('Bună Alex, poți trimite lista?').addressedToOther, false, 'the user\'s own name is not someone else');
  for (const text of ['Vineri, 2 octombrie, vă invităm la spectacol.', 'Dragi părinți, vă rog să semnați.', 'Bună ziua, mâine avem ședință.', 'Neata, ne vedem la birou.']) {
    assert.equal(opening(text).addressedToOther, false, text);
  }
  const mention = normalizeMessage(groupMessage({ extendedTextMessage: {
    text: 'Maria, @99000000000001 confirmă și tu', contextInfo: { mentionedJid: ['99000000000001@lid'] },
  } }), group.name, '', self, 'Alex Pop');
  assert.equal(mention.addressedToOther, false, 'a mention of the user wins');
});

test('requests to someone else in large groups and newsletter prices stay out of the inbox', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadmark-relevance-2-'));
  const jev = {
    status: () => ({ enabled: true, provider: 'TypeSafe AI', model: 'jev-test', threshold: 0.78 }),
    async evaluate(text, monitors = [], options = {}) {
      const personal = text.includes('your account');
      const detections = options.includeBuiltIns !== false && text.includes('poză') ? [{
        type: 'reminder', key: 'jev-reminder', title: 'Action or deadline mentioned', confidence: 0.9, priority: 0.2,
        amountMinor: null, currency: null, eventAt: null, notify: true, details: { detector: 'jev', model: 'jev-test' },
      }] : [];
      return {
        ...this.status(), available: true, detections, scores: { payment: options.verifyPayment ? 0.32 : 0.1 },
        signals: {
          replyNeeded: 0.1, promotional: 0.8,
          personalObligation: personal ? 0.4 : 0.05, transactional: 0.05, recipientSpecific: personal ? 0.6 : 0.04,
        },
      };
    },
  };
  const app = createThreadmarkServer({
    config: { dataDir, webDir: path.join(root, 'app/web'), adminToken: '7'.repeat(64), bridgeToken: '8'.repeat(64), cookieSecure: false },
    push: { enabled: false, publicKey: '', notifyItem: async () => {} }, jev,
  });
  const inbox = { id: 'gmail:label:INBOX', name: 'Inbox', kind: 'gmail_label' };
  const family = { id: '120363000000000666@g.us', name: 'Synthetic family', kind: 'group' };
  app.store.upsertGroups([{ id: group.id, name: group.name, participantCount: 40 }, { id: family.id, name: family.name, participantCount: 3 }]);
  app.store.selectGroup(group.id, true); app.store.selectGroup(family.id, true);
  app.store.upsertGmailSources([inbox]); app.store.selectGmailSource(inbox.id, true);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let sequence = 0;
  const send = (text, source, extra = {}) => fetch(`${base}/internal/events`, {
    method: 'POST', headers: { 'x-bridge-token': '8'.repeat(64), 'content-type': 'application/json' },
    body: JSON.stringify({ id: `relevance-2-${++sequence}`, sourceId: source.id, sourceName: source.name, sourceKind: source.kind,
      senderId: 'synthetic-sender', senderName: 'Synthetic sender', sentAt: new Date().toISOString(), direction: 'incoming', text, ...extra }),
  }).then((response) => response.json());

  const request = 'Bună Maria, pune și o poză te rog.';
  assert.deepEqual((await send(request, group, { addressedToMe: false, addressedToOther: true })).items, []);
  assert.equal((await send(request, family, { addressedToMe: false, addressedToOther: true })).items.length, 1, 'small groups keep it');
  assert.equal((await send('Bună ziua, pune și o poză te rog.', group, { addressedToMe: false, addressedToOther: false })).items.length, 1);

  const newsletter = await send('The premium edition costs $57.80 per year. Payment terms apply.', inbox);
  assert.equal(newsletter.items[0].details.attentionTriage.disposition, 'promotional');
  assert.equal(newsletter.items[0].notify, false);
  const personal = await send('Payment of 57.80 USD for your account is due.', inbox);
  assert.equal(personal.items.find((item) => item.type === 'payment').details.attentionTriage.disposition, undefined);
});

test('Gmail mass promotions leave the inbox, but invoices and transactions stay', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadmark-relevance-3-'));
  const jev = {
    status: () => ({ enabled: true, provider: 'TypeSafe AI', model: 'jev-test', threshold: 0.78 }),
    async evaluate(text) {
      const transactional = text.includes('order') ? 0.97 : 0.05;
      return {
        ...this.status(), available: true, detections: [], scores: { payment: 0.5 },
        signals: { replyNeeded: text.includes('reply') ? 0.95 : 0.1, promotional: 0.95, personalObligation: 0.35, transactional, recipientSpecific: 0.09 },
      };
    },
  };
  const app = createThreadmarkServer({
    config: { dataDir, webDir: path.join(root, 'app/web'), adminToken: '7'.repeat(64), bridgeToken: '8'.repeat(64), cookieSecure: false },
    push: { enabled: false, publicKey: '', notifyItem: async () => {} }, jev,
  });
  const inbox = { id: 'gmail:label:INBOX', name: 'Inbox', kind: 'gmail_label' };
  app.store.upsertGmailSources([inbox]); app.store.selectGmailSource(inbox.id, true);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let sequence = 0;
  const send = (text) => fetch(`${base}/internal/events`, {
    method: 'POST', headers: { 'x-bridge-token': '8'.repeat(64), 'content-type': 'application/json' },
    body: JSON.stringify({ id: `relevance-3-${++sequence}`, sourceId: inbox.id, sourceName: inbox.name, sourceKind: inbox.kind,
      senderId: 'synthetic-sender', senderName: 'Synthetic sender', sentAt: new Date().toISOString(), text }),
  }).then((response) => response.json());

  const subscription = await send('Your subscription price has changed to 10 USD per month. Paid consultation: please reply if interested.');
  assert.ok(subscription.items.length >= 2, 'a subscription item and a reply request');
  for (const item of subscription.items) {
    assert.equal(item.details.attentionTriage.disposition, 'promotional', item.title);
    assert.equal(item.notify, false);
  }
  const invoice = await send('Your invoice is ready. Amount: 31 RON.');
  assert.equal(invoice.items.find((item) => item.details.invoice).details.attentionTriage.disposition, undefined);
  const order = await send('Payment for your order: 31 RON.');
  assert.ok(order.items.length, 'the order email creates a payment item');
  for (const item of order.items) assert.notEqual(item.details.attentionTriage?.disposition, 'promotional', 'transactional mail stays');
});
