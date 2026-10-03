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

test('a failed Done notification action opens the item instead', async () => {
  const harness = serviceWorkerHarness(async () => ({ ok: false }));
  let completion;
  harness.listeners.notificationclick({
    action: 'done',
    notification: { data: { itemId: 'message:item', url: '/#item=message%3Aitem' }, close: () => {} },
    waitUntil: (promise) => { completion = promise; },
  });
  await completion;
  assert.deepEqual(harness.opened, ['https://threadmark.test/#item=message%3Aitem']);
});
