import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationPayload } from '../app/server/push.mjs';
import { PushService } from '../app/server/push.mjs';
import { createRequire } from 'node:module';

test('dismiss control pushes go only to workers that advertised support', async (t) => {
  const webpush = createRequire(new URL('../app/server/push.mjs', import.meta.url))('web-push');
  const delivered = [];
  t.mock.method(webpush, 'sendNotification', async (subscription, payload) => { delivered.push([subscription.endpoint, JSON.parse(payload)]); });
  const service = new PushService({}, { subscriptions: () => [
    { endpoint: 'https://push.invalid/old', subscription: { endpoint: 'https://push.invalid/old' } },
    { endpoint: 'https://push.invalid/current', subscription: { endpoint: 'https://push.invalid/current', threadmarkDismissal: true } },
  ] });
  service.enabled = true;
  await service.dismissItems({ type: 'dismiss', profileId: 'personal', itemIds: ['synthetic-item'] });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0][0], 'https://push.invalid/current');
  assert.deepEqual(delivered[0][1].itemIds, ['synthetic-item']);
  delivered.length = 0;
  const ids = Array.from({ length: 120 }, (_, i) => `synthetic-${i}-${'x'.repeat(100)}`);
  await service.dismissItems({ type: 'dismiss', profileId: 'personal', itemIds: ids });
  assert.deepEqual(delivered.flatMap(([, payload]) => payload.itemIds), ids);
  assert.ok(delivered.every(([, payload]) => Buffer.byteLength(JSON.stringify(payload)) <= 3500), 'large reply batches fit Web Push payload limits');
});

test('push notifications use the Threadmark app icon', () => {
  const payload = notificationPayload({
    id: 'message:item',
    type: 'reminder',
    title: 'Bring the signed form',
    source: { name: 'Parents' },
  });
  assert.equal(payload.icon, '/icons/icon-192.png');
  assert.equal(payload.badge, '/icons/icon-192.png');
  assert.equal(payload.title, 'Reminder matched');
  assert.equal(payload.itemId, 'message:item');
  assert.equal(payload.actionsUrl, '/#item=message%3Aitem&actions=1');
  assert.deepEqual(payload.actions, [{ action: 'done', title: 'Done' }, { action: 'actions', title: 'Actions' }]);
});

test('urgent items are identified in the notification title', () => {
  const payload = notificationPayload({
    id: 'urgent:item', type: 'reminder', title: 'Reply today', priority: 0.91,
    source: { name: 'Family' },
  });
  assert.equal(payload.title, 'Urgent · Reminder matched');
});

test('Dev notifications are labeled and deep-link to the Dev profile', () => {
  const payload = notificationPayload({
    id: 'dev:item', type: 'reminder', title: 'Build failed',
    source: { name: 'CI' }, profile: { id: 'dev', name: 'Dev' },
  });
  assert.equal(payload.title, 'Dev · Reminder matched');
  assert.equal(payload.url, '/?profile=dev#item=dev%3Aitem');
  assert.equal(payload.tag, 'dev:dev:item');
});

test('contact photos that need review have a specific notification title', () => {
  const payload = notificationPayload({
    id: 'photo:item', type: 'reminder', title: 'Photo needs review',
    details: { needsReview: true }, source: { name: 'Family contact' },
  });
  assert.equal(payload.title, 'Photo needs review');
  assert.equal(payload.body, 'Family contact: Photo needs review');
});

test('invoices have a specific notification title', () => {
  const payload = notificationPayload({
    id: 'invoice:item', type: 'payment', title: 'Invoice needs attention', priority: null,
    source: { name: 'Inbox' }, senderName: 'Utility', details: { invoice: true },
  });
  assert.equal(payload.title, 'Invoice received');
});

test('subscription lifecycle events have a specific notification title', () => {
  const payload = notificationPayload({
    id: 'subscription:item', type: 'payment', title: 'Subscription renewed', priority: null,
    source: { name: 'Inbox' }, details: { subscription: true, subscriptionEvent: 'renewed' },
  });
  assert.equal(payload.title, 'Subscription update');
});

test('push payloads carry what the service worker needs to summarise alerts', () => {
  const payload = notificationPayload({
    id: 'message:dev', type: 'payment', title: 'Invoice', priority: 0.9,
    source: { name: 'Billing' }, profile: { id: 'dev', name: 'Dev' },
  });
  assert.equal(payload.category, 'payment');
  assert.equal(payload.urgent, true);
  assert.equal(payload.profileId, 'dev');
  assert.equal(payload.profileName, 'Dev');
  assert.equal(payload.profileUrl, '/?profile=dev');
});
