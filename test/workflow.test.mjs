import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractDueAt } from '../app/server/dates.mjs';
import { openDatabase, ThreadmarkStore } from '../app/server/store.mjs';
import { describeMedia } from '../bridge/media.mjs';

test('normalizes Romanian and English deadlines locally', () => {
  assert.equal(extractDueAt('Trimite formularul mâine la 18:30', '2026-10-01T10:00:00+03:00').dueAt, '2026-10-02T15:30:00.000Z');
  const friday = extractDueAt('Please reply next Friday at 09:15', '2026-10-01T10:00:00+03:00');
  assert.equal(friday.dueAt, '2026-10-09T06:15:00.000Z');
  assert.equal(extractDueAt('No date here', '2026-10-01T10:00:00Z'), null);
});

test('workflow preferences, feedback, snoozing, reply completion and payment warnings stay local', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'threadmark-workflow-'));
  const db = openDatabase(directory);
  try {
    const store = new ThreadmarkStore(db);
    const sourceId = '120363000000000111@g.us';
    store.upsertGroups([{ id: sourceId, name: 'Family', participantCount: 4 }]);
    store.selectGroup(sourceId, true);
    const settings = store.updateSettings({ contextAware: true, outgoingMonitoring: true, attachmentProcessing: true, dailyDigest: true, digestTime: '19:30', timeZone: 'Europe/Bucharest', replyDelayHours: 4 });
    assert.equal(settings.outgoingMonitoring, true);
    assert.equal(store.routingConfig().sourceIds[0], sourceId);

    const first = store.ingestMessage({ id: 'pay-1', groupId: sourceId, groupName: 'Family', senderName: 'Sample Sender', sentAt: '2026-10-01T10:00:00Z', text: 'Plata este 50 lei în RO00TEST0000000000000000.' });
    assert.equal(first.items.length, 1);
    const second = store.ingestMessage({ id: 'pay-2', groupId: sourceId, groupName: 'Family', senderName: 'Sample Sender', sentAt: '2026-10-01T11:00:00Z', text: 'Plata este 50 lei în RO00DEMO0000000000000000.' });
    assert.ok(second.items[0].details.safetyAlerts.some((alert) => alert.includes('Bank details changed')));

    store.ingestMessage({ id: 'subscription-1', groupId: sourceId, groupName: 'Family', senderName: 'Store', sentAt: '2026-10-01T11:05:00Z', text: 'Your subscription has renewed. Receipt total: 49,99 RON.' });
    const subscription = store.ingestMessage({ id: 'subscription-2', groupId: sourceId, groupName: 'Family', senderName: 'Store', sentAt: '2026-10-01T11:10:00Z', text: 'Your subscription has renewed. Receipt total: 49,99 RON.' });
    assert.equal(subscription.items[0].details.subscriptionEvent, 'renewed');
    assert.equal(subscription.items[0].details.safetyAlerts, undefined, 'routine renewals must not be labeled duplicate payment requests');

    const until = new Date(Date.now() + 3_600_000).toISOString();
    assert.equal(store.snoozeItem(first.items[0].id, until).snoozedUntil, until);
    assert.equal(store.listItems({ status: 'snoozed' }).length, 1);
    assert.equal(store.setItemFeedback(second.items[0].id, { feedback: 'wrong_category', category: 'reminder' }).type, 'reminder');

    const reply = store.ingestMessage({ id: 'reply-needed', groupId: sourceId, groupName: 'Family', senderName: 'Sample Sender', sentAt: '2026-10-01T12:00:00Z', text: 'Can you confirm?' }, [{
      type: 'reminder', key: 'reply', title: 'Reply requested', confidence: 0.9, eventAt: '2026-10-01T16:00:00Z', notify: true,
      details: { detector: 'jev', awaitingReply: true }, amountMinor: null, currency: null,
    }], { includeLocal: false });
    const contextAt = new Date().toISOString();
    store.recordContextMessage({ id: 'context-in', groupId: sourceId, groupName: 'Family', direction: 'incoming', sentAt: contextAt, text: 'Can you confirm?' });
    const completed = store.markSourceReplied({ id: 'context-out', groupId: sourceId, groupName: 'Family', direction: 'outgoing', sentAt: contextAt, text: 'Yes.' });
    assert.equal(completed.find((item) => item.id === reply.items[0].id).status, 'done');
    assert.equal(store.recentContext({ groupId: sourceId }).length, 1);

    const nearDueAt = new Date(Date.now() + 30 * 60_000).toISOString();
    const nearDue = store.ingestMessage({ id: 'near-due', groupId: sourceId, groupName: 'Family', senderName: 'Ana', sentAt: new Date().toISOString(), text: 'Bring the form soon.' }, [{
      type: 'reminder', key: 'near-due', title: 'Near deadline', confidence: 0.9, eventAt: nearDueAt, notify: true,
      details: { detector: 'jev' }, amountMinor: null, currency: null,
    }], { includeLocal: false });
    store.markNotified(nearDue.items[0].id);
    assert.equal(store.dueNotifications().some((item) => item.id === nearDue.items[0].id), false, 'a near-term item must not repeat after its initial notification');
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('feeds use status-appropriate ordering', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'threadmark-feed-order-'));
  const db = openDatabase(directory);
  try {
    const store = new ThreadmarkStore(db);
    const sourceId = '120363000000000222@g.us';
    store.upsertGroups([{ id: sourceId, name: 'Ordering', participantCount: 2 }]);
    store.selectGroup(sourceId, true);
    const add = (id, priority = null) => store.ingestMessage({
      id, groupId: sourceId, groupName: 'Ordering', senderName: 'Sample Sender', sentAt: '2026-10-01T10:00:00Z', text: id,
    }, [{
      type: 'reminder', key: 'test', title: id, confidence: 0.9, priority,
      eventAt: null, notify: true, details: { detector: 'test' }, amountMinor: null, currency: null,
    }], { includeLocal: false }).items[0];

    const doneUrgent = add('done-urgent-old', 0.95);
    const doneRecent = add('done-recent', null);
    store.setItemStatus(doneUrgent.id, 'done');
    store.setItemStatus(doneRecent.id, 'done');
    db.prepare('UPDATE attention_items SET resolved_at=? WHERE id=?').run('2026-10-01T10:00:00.000Z', doneUrgent.id);
    db.prepare('UPDATE attention_items SET resolved_at=? WHERE id=?').run('2026-10-02T10:00:00.000Z', doneRecent.id);
    assert.deepEqual(store.listItems({ status: 'done' }).map((item) => item.id), [doneRecent.id, doneUrgent.id]);

    const openRecent = add('open-recent', null);
    const openUrgent = add('open-urgent', 0.95);
    assert.equal(store.listItems({ status: 'open' })[0].id, openUrgent.id);
    assert.ok(store.listItems({ status: 'open' }).some((item) => item.id === openRecent.id));

    const snoozedLater = add('snoozed-later-urgent', 0.95);
    const snoozedSooner = add('snoozed-sooner', null);
    const later = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const sooner = new Date(Date.now() + 3_600_000).toISOString();
    store.snoozeItem(snoozedLater.id, later);
    store.snoozeItem(snoozedSooner.id, sooner);
    assert.deepEqual(store.listItems({ status: 'snoozed' }).map((item) => item.id), [snoozedSooner.id, snoozedLater.id]);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('recognizes attachment types without reading media', () => {
  assert.equal(describeMedia({ imageMessage: { mimetype: 'image/jpeg' } }).kind, 'image');
  assert.equal(describeMedia({ documentMessage: { mimetype: 'application/pdf', fileName: 'form.pdf' } }).public.fileName, 'form.pdf');
  assert.equal(describeMedia({ conversation: 'plain text' }), null);
});
