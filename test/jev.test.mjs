import test from 'node:test';
import assert from 'node:assert/strict';
import { JevDetector } from '../app/server/jev.mjs';

test('Jev receives message text without WhatsApp identity metadata', async () => {
  let request;
  let options;
  const client = {
    async systemOne(nextRequest, nextOptions) {
      request = nextRequest;
      options = nextOptions;
      return {
        model: 'jev-test',
        answers: {
          payment: { type: 'noul', noul: 0.91 },
          meeting: { type: 'noul', noul: 0.12 },
          reminder: { type: 'noul', noul: 0.67 },
          invoice: { type: 'noul', noul: 0.08 },
          urgency: { type: 'noul', noul: 0.88 },
          promotional: { type: 'noul', noul: 0.06 },
          personal_obligation: { type: 'noul', noul: 0.93 },
          transactional: { type: 'noul', noul: 0.89 },
        },
        usage: { input_tokens: 100, output_tokens: 10 },
      };
    },
  };
  const detector = new JevDetector({ jevEnabled: true, jevThreshold: 0.78, jevTimeoutMs: 3_000 }, client);
  const result = await detector.evaluate('Trebuie achitată contribuția pentru excursie.');
  assert.deepEqual(request.state, { message: 'Trebuie achitată contribuția pentru excursie.' });
  assert.equal(Object.keys(request.state).length, 1);
  assert.equal(Object.keys(request.questions).length, 8);
  assert.deepEqual(options, { timeout: 3_000, retry: { maxRetries: 0 } });
  assert.equal(result.detections.length, 1);
  assert.equal(result.detections[0].type, 'payment');
  assert.equal(result.detections[0].confidence, 0.91);
  assert.equal(result.detections[0].priority, 0.88);
  assert.equal(result.signals.urgency, 0.88);
  assert.equal(result.signals.promotional, 0.06);
  assert.equal(result.signals.personalObligation, 0.93);
  assert.equal(result.signals.transactional, 0.89);
  assert.deepEqual(result.detections[0].details.scores, { payment: 0.91, meeting: 0.12, reminder: 0.67 });
});

test('Jev promotes a concrete invoice to a payment at the invoice threshold', async () => {
  const client = { async systemOne() {
    return {
      model: 'jev-test',
      answers: {
        payment: { type: 'noul', noul: 0.37 },
        meeting: { type: 'noul', noul: 0.03 },
        reminder: { type: 'noul', noul: 0.16 },
        invoice: { type: 'noul', noul: 0.86 },
        urgency: { type: 'noul', noul: 0.12 },
      },
    };
  } };
  const detector = new JevDetector({ jevEnabled: true, jevThreshold: 0.78, jevInvoiceThreshold: 0.68 }, client);
  const result = await detector.evaluate('Factura este disponibilă în contul de client.');
  assert.equal(result.signals.invoice, 0.86);
  assert.equal(result.detections.length, 1);
  assert.equal(result.detections[0].type, 'payment');
  assert.equal(result.detections[0].key, 'jev-invoice');
  assert.equal(result.detections[0].title, 'Invoice needs attention');
  assert.equal(result.detections[0].confidence, 0.86);
  assert.equal(result.detections[0].details.invoice, true);
  assert.equal(result.detections[0].details.threshold, 0.68);
});

test('Jev keeps below-threshold judgments as no match', async () => {
  const client = { async systemOne() {
    return {
      model: 'jev-test',
      answers: {
        payment: { type: 'noul', noul: 0.54 },
        meeting: { type: 'noul', noul: 0.4 },
        reminder: { type: 'noul', noul: 0.77 },
      },
      usage: { input_tokens: 100, output_tokens: 10 },
    };
  } };
  const detector = new JevDetector({ jevEnabled: true, jevThreshold: 0.78 }, client);
  const result = await detector.evaluate('Poate ar trebui să facem ceva cândva.');
  assert.deepEqual(result.detections, []);
  assert.equal(result.scores.reminder, 0.77);
});

test('Jev batches semantic monitors and applies each monitor threshold', async () => {
  let request;
  const client = { async systemOne(nextRequest) {
    request = nextRequest;
    return {
      model: 'jev-test',
      answers: {
        payment: { type: 'noul', noul: 0.1 },
        meeting: { type: 'noul', noul: 0.2 },
        reminder: { type: 'noul', noul: 0.4 },
        urgency: { type: 'noul', noul: 0.86 },
        promotional: { type: 'noul', noul: 0.08 },
        personal_obligation: { type: 'noul', noul: 0.91 },
        transactional: { type: 'noul', noul: 0.72 },
        monitor_0: { type: 'noul', noul: 0.92 },
        monitor_1: { type: 'noul', noul: 0.74 },
      },
    };
  } };
  const detector = new JevDetector({ jevEnabled: true, jevThreshold: 0.78 }, client);
  const monitors = [
    { id: 'decision', kind: 'semantic', name: 'Decision needed', condition: 'Someone needs a decision from me.', category: 'reminder', threshold: 0.8, notify: true },
    { id: 'transport', kind: 'semantic', name: 'School transport', condition: 'The school transport plan changed.', category: 'meeting', threshold: 0.75, notify: false },
  ];
  const result = await detector.evaluate('Tu ce variantă alegi pentru transport?', monitors);
  assert.equal(Object.keys(request.questions).length, 10);
  assert.equal(request.questions.monitor_0.instructions.monitoring_condition, monitors[0].condition);
  assert.equal(result.monitorScores.decision, 0.92);
  assert.equal(result.monitorScores.transport, 0.74);
  assert.equal(result.detections.length, 1);
  assert.equal(result.detections[0].title, 'Decision needed');
  assert.equal(result.detections[0].details.monitorId, 'decision');
  assert.equal(result.detections[0].priority, 0.86);
});

test('a semantic monitor can be tested without running built-in questions', async () => {
  let questionKeys;
  const client = { async systemOne(request) {
    questionKeys = Object.keys(request.questions);
    return { model: 'jev-test', answers: { monitor_0: { type: 'noul', noul: 0.81 } } };
  } };
  const detector = new JevDetector({ jevEnabled: true }, client);
  const monitor = { id: 'test', kind: 'semantic', name: 'Reply needed', condition: 'Someone asks me to reply.', category: 'reminder', threshold: 0.8 };
  const result = await detector.evaluateMonitor('Can you confirm today?', monitor);
  assert.deepEqual(questionKeys, ['monitor_0']);
  assert.equal(result.matched, true);
  assert.equal(result.probability, 0.81);
});

test('Jev is disabled without server-side configuration', async () => {
  let called = false;
  const detector = new JevDetector({ jevEnabled: false }, { async systemOne() { called = true; } });
  assert.deepEqual(await detector.detect({ text: 'Pay today' }), []);
  assert.equal(called, false);
  assert.equal(detector.status().enabled, false);
});

test('Jev receives only safe channel hints plus text and direction labels when context is explicitly enabled', async () => {
  let request;
  const answer = (choiceValue, confidence = 0.95) => ({ type: 'choice', choice: choiceValue, confidence, probabilities: { [choiceValue]: 1 } });
  const client = { async systemOne(nextRequest) {
    request = nextRequest;
    return {
      model: 'jev-test',
      answers: {
        changes_previous: { type: 'noul', noul: 0.91 }, cancels_previous: { type: 'noul', noul: 0.04 },
        reply_needed: { type: 'noul', noul: 0.87 }, suspicious_payment: { type: 'noul', noul: 0.03 },
        date_mode: answer('relative'), date_month: answer('none'), date_day: answer('none'), date_year: answer('none'),
        date_anchor: answer('tomorrow'), date_weekday: answer('none'), date_week_offset: answer('none'),
        date_hour: answer('18'), date_minute: answer('30'),
      },
    };
  } };
  const detector = new JevDetector({ jevEnabled: true }, client);
  const result = await detector.evaluate('Actually, tomorrow at 18:30.', [], {
    includeBuiltIns: false, contextAware: true, replyNeeded: true, paymentSafety: true, extractDate: true,
    referenceAt: '2026-10-01T10:00:00+03:00',
    messageContext: {
      channel: 'gmail', conversationKind: 'mailbox', senderEmail: 'private@example.test',
      gmailHints: { categoryPromotions: true, hasListUnsubscribe: true, precedenceBulk: false, autoSubmitted: true },
    },
    context: [{ direction: 'incoming', text: 'Meeting Friday at 17:00', sourceName: 'Private name', sourceId: 'secret@g.us' }],
  });
  assert.deepEqual(request.state, {
    message: 'Actually, tomorrow at 18:30.',
    message_context: {
      channel: 'gmail', conversation_kind: 'mailbox',
      gmail_hints: { category_promotions: true, has_list_unsubscribe: true, precedence_bulk: false, auto_submitted: true },
    },
    recent_messages: [{ direction: 'incoming', text: 'Meeting Friday at 17:00' }],
  });
  assert.equal(result.signals.changesPrevious, 0.91);
  assert.equal(result.signals.replyNeeded, 0.87);
  assert.equal(result.date.dueAt, '2026-10-02T15:30:00.000Z');
});
