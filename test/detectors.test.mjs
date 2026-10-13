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

test('detects real subscription lifecycle events but ignores test purchase receipts', () => {
  const renewed = detectAttention({ text: 'Your annual subscription has been renewed. Receipt total: 49,99 RON.' });
  const failed = detectAttention({ text: 'We could not process your subscription payment. Your card was declined.' });
  const price = detectAttention({ text: 'Your subscription price will increase to 59,99 RON next month.' });
  const expiring = detectAttention({ text: 'Your membership expires on 10.10.2026.' });
  const cancelled = detectAttention({ text: 'Your subscription has been cancelled and will not renew.' });
  const purchased = detectAttention({ text: 'Your order receipt\n\nAnnual subscription — 99,99 RON.' });
  const testReceipt = detectAttention({ text: 'Test: Your Google Play Order Receipt\n\n15 minute subscription — 37,99 RON.' });

  assert.equal(renewed[0]?.details.subscriptionEvent, 'renewed');
  assert.equal(renewed[0]?.amountMinor, 4999);
  assert.equal(failed[0]?.details.subscriptionEvent, 'payment-failed');
  assert.equal(failed[0]?.priority, 0.95);
  assert.equal(price[0]?.details.subscriptionEvent, 'price-change');
  assert.equal(expiring[0]?.details.subscriptionEvent, 'expiring');
  assert.equal(cancelled[0]?.details.subscriptionEvent, 'cancelled');
  assert.equal(purchased[0]?.details.subscriptionEvent, 'purchased');
  assert.deepEqual(testReceipt, []);
});

test('does not treat subscription marketing as a lifecycle event', () => {
  assert.deepEqual(detectAttention({ text: 'Subscribe now and save 20% on a new membership plan.' }), []);
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

test('currency symbols do not turn an option expiry day into a payment amount', () => {
  const text = 'Market example: holders of the Nov 17 $12 call may get paid if the stock rises.';
  const items = detectAttention({ text });
  assert.equal(items.find((item) => item.type === 'payment')?.amountMinor, 1200);
  assert.equal(items.some((item) => item.type === 'meeting'), false);
  for (const text of ['Payment due: $12.50.', 'Payment due: 12.50 $.', 'Plata este RON 12,50.']) {
    assert.equal(detectAttention({ text })[0].amountMinor, 1250);
  }
});

test('meeting detection cannot combine financial decimals and unrelated narrative clocks', () => {
  const text = 'The example starts at 11:42 pm.\n\nRevenue is 1.6% ahead and performance is 3.4 times higher.\n\nDiscuss these ideas at your board meeting.';
  assert.equal(detectAttention({ text }).some((item) => item.type === 'meeting'), false);
  const actual = detectAttention({ text: 'Meeting on 17.11.2026 at 11:42 pm.', sentAt: '2026-10-01T10:00:00Z' });
  assert.equal(actual[0].eventAt, '2026-11-17T23:42:00.000Z');
});
