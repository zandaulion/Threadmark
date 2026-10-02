import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationPayload } from '../app/server/push.mjs';

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
});

test('urgent items are identified in the notification title', () => {
  const payload = notificationPayload({
    id: 'urgent:item', type: 'reminder', title: 'Reply today', priority: 0.91,
    source: { name: 'Family' },
  });
  assert.equal(payload.title, 'Urgent · Reminder matched');
});

test('contact photos that need review have a specific notification title', () => {
  const payload = notificationPayload({
    id: 'photo:item', type: 'reminder', title: 'Photo needs review',
    details: { needsReview: true }, source: { name: 'Family contact' },
  });
  assert.equal(payload.title, 'Photo needs review');
  assert.equal(payload.body, 'Family contact: Photo needs review');
});
