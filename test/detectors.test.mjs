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

test('detects a Romanian utility invoice without an amount', () => {
  const items = detectAttention({ text: 'Factura de gaze naturale este disponibilă în contul tău.' });
  assert.equal(items.length, 1);
  assert.equal(items[0].type, 'payment');
  assert.equal(items[0].key, 'invoice');
  assert.equal(items[0].title, 'Invoice needs attention');
  assert.equal(items[0].details.invoice, true);
  assert.equal(items[0].amountMinor, null);
});

test('detects a concrete English invoice notice without an amount', () => {
  const items = detectAttention({ text: 'Your new invoice is ready. View it in your account.' });
  assert.equal(items.length, 1);
  assert.equal(items[0].key, 'invoice');
  assert.equal(items[0].details.invoice, true);
});

test('does not treat generic invoicing marketing as an invoice', () => {
  const items = detectAttention({ text: 'Learn how invoice automation can improve your business.' });
  assert.equal(items.some((item) => item.key === 'invoice'), false);
});

test('does not combine distant invoice and billing words across a long newsletter', () => {
  const text = `A profile mentions a business bill and an unusual loophole.${' The story continues without asking the reader to pay.'.repeat(12)} She only needed an internet connection to work abroad.`;
  assert.deepEqual(detectAttention({ text }), []);
});

test('keeps nearby invoice evidence local', () => {
  const withAmount = detectAttention({ text: 'Invoice 1842 is ready. Total: 245 RON.' });
  const withIban = detectAttention({ text: 'Factura poate fi achitată în RO00TEST0000000000000000.' });
  assert.equal(withAmount[0]?.key, 'invoice');
  assert.equal(withIban[0]?.key, 'invoice');
});

test('ignores paid receipts but keeps an explicit payment request', () => {
  const receipt = detectAttention({ text: 'Test: Your Google Play Order Receipt from 2 Oct 2026\n\nPayment completed: 37,99 RON.' });
  const unpaid = detectAttention({ text: 'Order receipt update\n\nBalance due: 37,99 RON. Please pay by tomorrow.' });
  assert.deepEqual(receipt, []);
  assert.equal(unpaid[0]?.type, 'payment');
  assert.equal(unpaid[0]?.amountMinor, 3799);
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
