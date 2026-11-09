import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function serviceWorkerHarness(fetchImpl = async () => ({ ok: true })) {
  const listeners = {};
  const notifications = [];
  const opened = [];
  const navigated = [];
  const context = {
    URL,
    JSON,
    encodeURIComponent,
    setTimeout,
    importScripts() {},
    fetch: fetchImpl,
    caches: { open: async () => ({ addAll: async () => {}, put: async () => {} }), keys: async () => [], delete: async () => true, match: async () => null },
    self: {
      location: { origin: 'https://threadmark.test' },
      addEventListener: (name, handler) => { listeners[name] = handler; },
      skipWaiting: async () => {},
      registration: { showNotification: async (title, options) => { notifications.push({ title, options }); } },
      clients: {
        claim: async () => {},
        matchAll: async () => [],
        openWindow: async (url) => { opened.push(url); },
      },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'app/web/sw.js'), 'utf8'), context);
  return { listeners, notifications, opened, navigated, context };
}

test('service worker displays Done and Actions notification buttons', async () => {
  const harness = serviceWorkerHarness();
  let completion;
  harness.listeners.push({
    data: { json: () => ({
      title: 'Reminder matched', body: 'Family: Reply requested', url: '/#item=message%3Aitem',
      actionsUrl: '/#item=message%3Aitem&actions=1', itemId: 'message:item',
      actions: [{ action: 'done', title: 'Done' }, { action: 'actions', title: 'Actions' }],
    }) },
    waitUntil: (promise) => { completion = promise; },
  });
  await completion;
  assert.equal(harness.notifications.length, 1);
  assert.deepEqual(harness.notifications[0].options.actions, [
    { action: 'done', title: 'Done' }, { action: 'actions', title: 'Actions' },
  ]);
  assert.equal(harness.notifications[0].options.data.itemId, 'message:item');
});

test('Done notification action completes an item without opening the app', async () => {
  let request;
  const harness = serviceWorkerHarness(async (url, options) => { request = { url, options }; return { ok: true }; });
  let completion;
  let closed = false;
  harness.listeners.notificationclick({
    action: 'done',
    notification: { data: { itemId: 'message:item', url: '/#item=message%3Aitem' }, close: () => { closed = true; } },
    waitUntil: (promise) => { completion = promise; },
  });
  await completion;
  assert.equal(closed, true);
  assert.equal(request.url, '/api/items/message%3Aitem/status');
  assert.equal(request.options.method, 'POST');
  assert.deepEqual(JSON.parse(request.options.body), { status: 'done' });
  assert.deepEqual(harness.opened, []);
});

test('Actions notification action opens the item action menu URL', async () => {
  const harness = serviceWorkerHarness();
  let completion;
  harness.listeners.notificationclick({
    action: 'actions',
    notification: {
      data: { url: '/#item=message%3Aitem', actionsUrl: '/#item=message%3Aitem&actions=1', itemId: 'message:item' },
      close: () => {},
    },
    waitUntil: (promise) => { completion = promise; },
  });
  await completion;
  assert.deepEqual(harness.opened, ['https://threadmark.test/#item=message%3Aitem&actions=1']);
});

test('a failed Done notification action stays in the shade and restores an actionable notification', async () => {
  const harness = serviceWorkerHarness(async () => ({ ok: false }));
  let completion;
  harness.listeners.notificationclick({
    action: 'done',
    notification: { data: { itemId: 'message:item', url: '/#item=message%3Aitem' }, close: () => {} },
    waitUntil: (promise) => { completion = promise; },
  });
  await completion;
  assert.deepEqual(harness.opened, []);
  assert.equal(harness.notifications[0].options.silent, true);
  assert.equal(harness.notifications[0].options.actions[0].action, 'done');
});

function trayHarness() {
  const harness = serviceWorkerHarness();
  const tray = [];
  harness.context.self.registration.showNotification = async (title, options) => {
    const index = tray.findIndex((entry) => options.tag && entry.tag === options.tag);
    const entry = { title, ...options, close: () => { const at = tray.indexOf(entry); if (at >= 0) tray.splice(at, 1); } };
    if (index >= 0) tray.splice(index, 1, entry); else tray.push(entry);
  };
  harness.context.self.registration.getNotifications = async ({ tag } = {}) => tray.filter((entry) => !tag || entry.tag === tag);
  const push = (payload) => {
    let completion;
    harness.listeners.push({ data: { json: () => payload }, waitUntil: (promise) => { completion = promise; } });
    return completion;
  };
  return { ...harness, tray, push };
}

const alert = (id, category, extra = {}) => ({
  title: 'Payment mentioned', body: `Source ${id}: ${category}`, url: `/#item=${id}`, actionsUrl: `/#item=${id}&actions=1`,
  itemId: id, category, urgent: false, profileId: 'personal', profileName: 'Personal', profileUrl: '/',
  actions: [{ action: 'done', title: 'Done' }, { action: 'actions', title: 'Actions' }], ...extra,
});

test('alerts still on screen are folded into one summary notification', async () => {
  const { tray, push } = trayHarness();
  await push(alert('a', 'payment'));
  assert.equal(tray.length, 1);
  assert.equal(tray[0].title, 'Payment mentioned', 'a single alert looks as before');
  assert.equal(tray[0].actions.length, 2);
  await push(alert('b', 'payment'));
  await push(alert('c', 'reminder'));
  assert.equal(tray.length, 1);
  assert.equal(tray[0].title, '3 alerts · 2 payments, 1 action');
  assert.equal(tray[0].body, 'Source c: reminder\nSource b: payment\nSource a: payment');
  assert.equal(tray[0].tag, 'threadmark-alerts-personal');
  assert.equal(tray[0].renotify, true);
  assert.deepEqual(tray[0].actions, undefined);
  assert.equal(tray[0].data.url, '/');
  await push(alert('d', 'meeting', { urgent: true }));
  assert.equal(tray[0].title, 'Urgent · 4 alerts · 2 payments, 1 meeting, 1 action');
  assert.match(tray[0].body, /\+1 more$/u);
});

test('a dismissed summary starts a fresh count, profiles stay separate and repeats are not counted twice', async () => {
  const { tray, push } = trayHarness();
  await push(alert('a', 'payment'));
  await push(alert('b', 'reminder'));
  tray[0].close();
  await push(alert('c', 'meeting'));
  assert.equal(tray[0].title, 'Payment mentioned', 'after dismissal the next alert stands alone');
  await push(alert('c', 'meeting'));
  assert.equal(tray[0].title, 'Payment mentioned', 'a repeated alert for the same item does not add to the count');
  await push(alert('x', 'reminder', { profileId: 'dev', profileName: 'Dev', profileUrl: '/?profile=dev' }));
  await push(alert('y', 'reminder', { profileId: 'dev', profileName: 'Dev', profileUrl: '/?profile=dev' }));
  assert.equal(tray.length, 2);
  assert.equal(tray[1].title, 'Dev · 2 alerts · 2 actions');
  assert.equal(tray[1].data.url, '/?profile=dev');
});

test('alerts arriving at the same moment are both counted', async () => {
  const { tray, push } = trayHarness();
  await Promise.all([push(alert('a', 'payment')), push(alert('b', 'payment')), push(alert('c', 'reminder'))]);
  assert.equal(tray.length, 1);
  assert.equal(tray[0].title, '3 alerts · 2 payments, 1 action');
});

test('reply dismissal removes one grouped alert quietly and never recreates a missing notification', async () => {
  const { tray, push } = trayHarness();
  await push(alert('a', 'payment'));
  await push(alert('b', 'reminder'));
  await push(alert('dev', 'meeting', { profileId: 'dev', profileName: 'Dev', profileUrl: '/?profile=dev' }));
  await push({ type: 'dismiss', profileId: 'personal', itemIds: ['b'] });
  assert.equal(tray.length, 2);
  assert.deepEqual(Array.from(tray[0].data.alerts, (a) => a.itemId), ['a']);
  assert.equal(tray[0].data.itemId, 'a');
  assert.equal(tray[0].actions[0].action, 'done');
  assert.equal(tray[0].silent, true);
  assert.equal(tray[0].renotify, false);
  await push({ type: 'dismiss', profileId: 'personal', itemIds: ['a'] });
  assert.equal(tray.length, 1);
  await push({ type: 'dismiss', profileId: 'personal', itemIds: ['missing'] });
  assert.equal(tray.length, 1, 'the Dev notification and dismissed notifications stay untouched');
});

test('foreground messages dismiss alerts and Done does not close other profiles or open a window', async () => {
  const { tray, push, listeners, opened } = trayHarness();
  await push(alert('a', 'payment'));
  await push(alert('dev', 'meeting', { profileId: 'dev', profileName: 'Dev', profileUrl: '/?profile=dev' }));
  let completion;
  listeners.notificationclick({ action: 'done', notification: tray[0], waitUntil: (p) => { completion = p; } });
  await completion;
  assert.equal(tray.length, 1);
  assert.equal(tray[0].data.itemId, 'dev');
  assert.deepEqual(opened, []);
  listeners.message({ data: { type: 'dismiss', profileId: 'dev', itemIds: ['dev'] }, waitUntil: (p) => { completion = p; } });
  await completion;
  assert.equal(tray.length, 0);
});

test('late alert pushes are checked against persisted dismissal state', async () => {
  const harness = serviceWorkerHarness(async () => ({ ok: true, json: async () => ({ dismissedIds: ['answered'] }) }));
  let completion;
  harness.context.self.registration.getNotifications = async () => [];
  harness.listeners.push({ data: { json: () => alert('answered', 'reminder') }, waitUntil: (p) => { completion = p; } });
  await completion;
  assert.equal(harness.notifications.length, 0);
});

test('worker advertises dismissal support before the server sends control pushes', () => {
  const { listeners } = serviceWorkerHarness();
  let result;
  listeners.message({ data: { type: 'notification-capabilities' }, ports: [{ postMessage: (value) => { result = value; } }] });
  assert.equal(result.dismiss, true);
});

test('Done on an older single notification preserves alerts added to its group meanwhile', async () => {
  const { tray, push, listeners } = trayHarness();
  await push(alert('a', 'payment'));
  const clicked = tray[0];
  // Model a native close by tag: closing an old handle could remove a newer summary.
  clicked.close = () => { const index = tray.findIndex((n) => n.tag === clicked.tag); if (index >= 0) tray.splice(index, 1); };
  await push(alert('b', 'reminder'));
  let completion;
  listeners.notificationclick({ action: 'done', notification: clicked, waitUntil: (p) => { completion = p; } });
  await completion;
  assert.equal(tray.length, 1);
  assert.equal(tray[0].data.itemId, 'b');
  assert.equal(tray[0].silent, true);
});
