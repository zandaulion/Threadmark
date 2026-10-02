import test from 'node:test';
import assert from 'node:assert/strict';
import { detectAttention } from '../app/server/detectors.mjs';

test('detects a Romanian payment with amount and IBAN', () => {
  const items = detectAttention({ text: 'Vă rog plata de 125,50 lei în contul RO00TEST0000000000000000 până vineri.' });
  assert.equal(items.length, 1);
  assert.equal(items[0].type, 'payment');
  assert.equal(items[0].amountMinor, 12550);
  assert.equal(items[0].currency, 'RON');
  assert.equal(items[0].details.iban, 'RO00TEST0000000000000000');
});

test('detects a meeting with date and time', () => {
  const items = detectAttention({ text: 'Ședință pe 05.10.2026 la ora 18:30, pe Teams.', sentAt: '2026-10-01T10:00:00Z' });
  assert.equal(items.length, 1);
  assert.equal(items[0].type, 'meeting');
  assert.equal(items[0].eventAt, '2026-10-05T18:30:00.000Z');
});

test('ignores ordinary conversation', () => {
  assert.deepEqual(detectAttention({ text: 'Mulțumesc, am văzut fotografia.' }), []);
});
