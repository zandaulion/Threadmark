import { choice, noul, TypeSafeClient } from '@typesafe-ai/sdk';
import { resolveJevDate } from './dates.mjs';

const QUESTIONS = {
  payment: noul(
    'Does the message in `message` contain a payment matter that the recipient should notice or act on? The message may be Romanian or English.',
    {
      true: 'The recipient may need to pay, transfer, collect, confirm, record, or follow up about money, fees, dues, contributions, invoices, refunds, or bank details.',
      false: 'There is no actionable or important payment matter for the recipient. A receipt or confirmation for money already paid is informational unless it explicitly asks the recipient to act.',
    },
  ),
  meeting: noul(
    'Does the message in `message` establish, change, cancel, or request action about a meeting, appointment, class, call, or scheduled event? The message may be Romanian or English.',
    {
      true: 'A date, time, location, attendance decision, cancellation, or schedule change matters to the recipient.',
      false: 'There is no concrete scheduling or attendance matter for the recipient.',
    },
  ),
  reminder: noul(
    'Does the message in `message` give the recipient a non-payment, non-meeting task or deadline that they should remember? The message may be Romanian or English.',
    {
      true: 'The recipient is asked or reminded to bring, submit, sign, complete, confirm, reply, or otherwise follow up on something.',
      false: 'There is no task or deadline, or the only matter is a payment or meeting already covered by another category.',
    },
  ),
};

const SIGNAL_QUESTIONS = {
  invoice: noul(
    'Does the message in `message` tell the recipient that a real invoice, bill, utility statement, or amount due for them has been issued, attached, is available, or needs review or payment? The message may be Romanian or English.',
    {
      true: 'A concrete invoice or bill relevant to the recipient is attached, issued, ready, available through a link or account, due, overdue, or presented for review or payment. An amount does not need to appear in the message.',
      false: 'The message merely markets or discusses invoicing, billing software, business files, or a hypothetical example; it is only a receipt for something already paid; or no concrete invoice or bill for the recipient is present.',
    },
  ),
  urgency: noul(
    'Does the message in `message` require prompt attention or action from the recipient today or very soon? The message may be Romanian or English.',
    {
      true: 'Delay could cause a missed deadline, failed obligation, lost opportunity, safety issue, or other meaningful problem; explicit urgency or a near deadline counts.',
      false: 'The message is informational, routine, optional, or can reasonably wait without a meaningful consequence.',
    },
  ),
};

const ATTENTION_QUESTIONS = {
  promotional: noul(
    'Is the primary purpose of `message` promotional: advertising, selling, promoting content, soliciting engagement, or inviting optional participation? When `message_context` is present, use it only as supporting evidence, never as an automatic answer. The message may be Romanian or English.',
    {
      true: 'The main purpose is marketing, a newsletter, a sales offer, a coupon, promotion of content, or an optional call to vote, follow, share, try, register, attend, or buy.',
      false: 'The main purpose is personal, administrative, transactional, account or service related, security related, or communicates a concrete obligation. A bulk message can still be non-promotional.',
    },
  ),
  personal_obligation: noul(
    'Does `message` communicate a concrete obligation, commitment, deadline, reply, payment, attendance requirement, or decision that applies specifically to the recipient? When `message_context` is present, use it to distinguish a direct request from a general or optional appeal. The message may be Romanian or English.',
    {
      true: 'The recipient is personally expected or required to act, reply, pay, attend, provide something, make a decision, or meet a deadline, with a meaningful consequence for ignoring it.',
      false: 'Any call to action is generic, rhetorical, promotional, advisory, or optional; a question to a group is not clearly directed at this recipient; or no concrete recipient obligation exists.',
    },
  ),
  transactional: noul(
    'Is `message` primarily about an existing transaction, service, account, order, delivery, reservation, ticket, bill, subscription, security matter, school or family administration, or another established relationship involving the recipient? The message may be Romanian or English.',
    {
      true: 'It concerns something the recipient already has, requested, owes, booked, ordered, uses, administers, or must handle, including a real invoice, service change, booking update, school form, or account alert.',
      false: 'It is mainly acquisition marketing, general content, an optional event or offer, or has no concrete existing relationship or administrative matter for the recipient.',
    },
  ),
  recipient_specific: noul(
    'Does `message` concern the recipient\'s own account, order, booking, delivery, bill, subscription, configuration, relationship, or required administrative matter rather than a broad announcement for many recipients? When `message_context` is present, use it only as supporting evidence. The message may be Romanian or English.',
    {
      true: 'The message is tied to something specific to this recipient, such as their actual account, transaction, service state, reservation, child, household, application, or required decision.',
      false: 'It is a general product update, broad announcement, marketing campaign, newsletter, generic advice, or optional opportunity without evidence that it affects this recipient specifically.',
    },
  ),
};

const CONTEXT_QUESTIONS = {
  changes_previous: noul(
    'Does `message` correct, reschedule, replace, or otherwise change an actionable detail in `recent_messages`?',
    { true: 'It clearly changes an earlier date, time, place, amount, payment detail, task, or decision.', false: 'It is new information or does not clearly modify an earlier actionable message.' },
  ),
  cancels_previous: noul(
    'Does `message` explicitly cancel, withdraw, or say to ignore an actionable item in `recent_messages`?',
    { true: 'An earlier obligation, event, request, or payment instruction no longer applies.', false: 'Nothing earlier is clearly cancelled or withdrawn.' },
  ),
  reply_needed: noul(
    'Does `message` directly ask the recipient for an answer, confirmation, decision, document, or other response?',
    { true: 'The recipient is personally expected to respond or confirm.', false: 'The message is informational, rhetorical, or addressed generally without requiring the recipient to reply.' },
  ),
  suspicious_payment: noul(
    'Does `message` contain a potentially risky or unusual payment request that deserves verification before acting?',
    { true: 'Examples include changed bank details, secrecy, credentials, gift cards, crypto, remote access, or pressure that makes independent verification prudent.', false: 'It is an ordinary payment message with no concrete warning sign.' },
  ),
};

const DATE_QUESTIONS = {
  date_mode: choice('How is the actionable deadline or event date in `message` written?', {
    absolute: 'A calendar date with a day and month is stated.', relative: 'Today, tomorrow, the day after tomorrow, or a weekday is stated.', none: 'No actionable deadline or event date is stated.',
  }),
  date_month: choice('If an absolute actionable date is stated, which month number is it?', Object.fromEntries([...Array(12)].map((_, index) => [String(index + 1), null]).concat([['none', 'No month is stated.']]))),
  date_day: choice('If an absolute actionable date is stated, which day of the month is it?', Object.fromEntries([...Array(31)].map((_, index) => [String(index + 1), null]).concat([['none', 'No day is stated.']]))),
  date_year: choice('If an absolute actionable date is stated, which year is it?', Object.fromEntries([...Array(8)].map((_, index) => [String(new Date().getFullYear() - 1 + index), null]).concat([['none', 'No year is stated.']]))),
  date_anchor: choice('If an actionable date is relative, which anchor is stated?', {
    today: null, tomorrow: null, day_after_tomorrow: null, weekday: 'A named weekday.', none: 'No relative date is stated.',
  }),
  date_weekday: choice('If an actionable date names a weekday, which day number is it? 0 is Sunday and 6 is Saturday.', {
    '0': 'Sunday / duminică', '1': 'Monday / luni', '2': 'Tuesday / marți', '3': 'Wednesday / miercuri',
    '4': 'Thursday / joi', '5': 'Friday / vineri', '6': 'Saturday / sâmbătă', none: 'No weekday is stated.',
  }),
  date_week_offset: choice('If a weekday is stated, is it explicitly next week?', { current: 'This week or a bare weekday.', next: 'Next week.', none: 'No weekday is stated.' }),
  date_hour: choice('If an actionable time is stated, which hour from 0 to 23 is it?', Object.fromEntries([...Array(24)].map((_, index) => [String(index), null]).concat([['none', 'No time is stated.']]))),
  date_minute: choice('If an actionable time is stated, which minute is it?', Object.fromEntries([...Array(60)].map((_, index) => [String(index), null]).concat([['none', 'No minute is stated.']]))),
};

const TITLES = {
  payment: 'Payment may need attention',
  meeting: 'Meeting or appointment mentioned',
  reminder: 'Action or deadline mentioned',
};

export class JevDetector {
  constructor(config = {}, client = null) {
    this.model = String(config.jevModel || 'jev-latest');
    this.threshold = boundedNumber(config.jevThreshold, 0.78, 0.5, 0.99);
    this.invoiceThreshold = boundedNumber(config.jevInvoiceThreshold, 0.68, 0.5, 0.99);
    this.timeout = boundedNumber(config.jevTimeoutMs, 4_500, 500, 8_000);
    this.enabled = Boolean(config.jevEnabled && (client || config.typesafeApiKey));
    this.lastSuccessAt = null;
    this.lastFailureAt = null;
    this.client = this.enabled ? client || new TypeSafeClient({
      apiKey: config.typesafeApiKey,
      defaultModel: this.model,
      timeout: this.timeout,
      retry: { maxRetries: 0 },
      logLevel: 'off',
    }) : null;
  }

  status() {
    return {
      enabled: this.enabled,
      provider: 'TypeSafe AI',
      model: this.model,
      threshold: this.threshold,
      invoiceThreshold: this.invoiceThreshold,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
    };
  }

  async evaluate(text, monitors = [], options = {}) {
    if (!this.enabled) return { ...this.status(), available: false, error: 'jev_not_configured', scores: {}, detections: [] };
    const message = String(text || '').trim().slice(0, 12_000);
    if (!message) return { ...this.status(), available: true, scores: {}, detections: [] };
    const includeBuiltIns = options.includeBuiltIns !== false;
    const includeContext = Boolean(options.contextAware || options.replyNeeded || options.paymentSafety);
    const includeDate = Boolean(options.extractDate);
    const includeAttentionSignals = includeBuiltIns || Boolean(options.attentionSignals);
    const semanticMonitors = normaliseMonitors(monitors);
    const questions = {
      ...(includeBuiltIns ? { ...QUESTIONS, ...SIGNAL_QUESTIONS } : {}),
      ...(includeAttentionSignals ? ATTENTION_QUESTIONS : {}),
      ...(includeContext ? CONTEXT_QUESTIONS : {}),
      ...(includeDate ? DATE_QUESTIONS : {}),
    };
    const monitorKeys = new Map();
    semanticMonitors.forEach((monitor, index) => {
      const key = `monitor_${index}`;
      monitorKeys.set(key, monitor);
      questions[key] = noul({
        question: 'Does the message in `message` match the user-defined monitoring condition?',
        monitoring_condition: monitor.condition,
        guidance: 'Judge only whether this message satisfies the condition. The message may be Romanian or English.',
      }, {
        true: 'The message clearly satisfies the monitoring condition.',
        false: 'The message does not satisfy the condition, is merely adjacent to it, or lacks enough evidence.',
      });
    });
    if (!Object.keys(questions).length) return { ...this.status(), available: true, scores: {}, monitorScores: {}, detections: [] };
    try {
      const recentMessages = normaliseContext(options.context);
      const messageContext = normaliseMessageContext(options.messageContext);
      const state = {
        message,
        ...(messageContext ? { message_context: messageContext } : {}),
        ...(recentMessages.length ? { recent_messages: recentMessages } : {}),
      };
      const response = await this.client.systemOne({
        state,
        model: this.model,
        questions,
      }, { timeout: this.timeout, retry: { maxRetries: 0 } });
      const scores = includeBuiltIns
        ? Object.fromEntries(Object.keys(TITLES).map((key) => [key, probability(response.answers?.[key]?.noul)]))
        : {};
      const signals = includeBuiltIns
        ? {
          invoice: probability(response.answers?.invoice?.noul),
          urgency: probability(response.answers?.urgency?.noul),
        }
        : {};
      if (includeAttentionSignals) {
        signals.promotional = probability(response.answers?.promotional?.noul);
        signals.personalObligation = probability(response.answers?.personal_obligation?.noul);
        signals.transactional = probability(response.answers?.transactional?.noul);
        signals.recipientSpecific = probability(response.answers?.recipient_specific?.noul);
      }
      if (includeContext) {
        signals.changesPrevious = probability(response.answers?.changes_previous?.noul);
        signals.cancelsPrevious = probability(response.answers?.cancels_previous?.noul);
        signals.replyNeeded = probability(response.answers?.reply_needed?.noul);
        signals.suspiciousPayment = probability(response.answers?.suspicious_payment?.noul);
      }
      const date = includeDate ? resolveJevDate({
        mode: response.answers?.date_mode,
        month: response.answers?.date_month,
        day: response.answers?.date_day,
        year: response.answers?.date_year,
        anchor: response.answers?.date_anchor,
        weekday: response.answers?.date_weekday,
        weekOffset: response.answers?.date_week_offset,
        hour: response.answers?.date_hour,
        minute: response.answers?.date_minute,
      }, options.referenceAt) : null;
      const monitorScores = Object.fromEntries([...monitorKeys].map(([key, monitor]) => [monitor.id, probability(response.answers?.[key]?.noul)]));
      const monitorDetections = [...monitorKeys].flatMap(([key, monitor]) => {
        const confidence = probability(response.answers?.[key]?.noul);
        return confidence >= monitor.threshold ? [{
          type: monitor.category,
          key: `jev-monitor-${monitor.id}`,
          title: monitor.name,
          confidence,
          priority: signals.urgency,
          amountMinor: null,
          currency: null,
          eventAt: date?.dueAt || null,
          notify: monitor.notify,
          details: {
            detector: 'jev',
            monitorId: monitor.id,
            model: response.model || this.model,
            probability: confidence,
            threshold: monitor.threshold,
            urgency: signals.urgency,
            dueAtSource: date?.source || null,
          },
        }] : [];
      });
      let detections = monitorDetections;
      if (!detections.length && includeBuiltIns) {
        if (signals.invoice >= this.invoiceThreshold) {
          detections = [{
            type: 'payment',
            key: 'jev-invoice',
            title: 'Invoice needs attention',
            confidence: signals.invoice,
            priority: signals.urgency,
            amountMinor: null,
            currency: null,
            eventAt: date?.dueAt || null,
            notify: true,
            details: {
              detector: 'jev', invoice: true, model: response.model || this.model,
              probability: signals.invoice, threshold: this.invoiceThreshold,
              scores, urgency: signals.urgency, dueAtSource: date?.source || null,
            },
          }];
        } else {
          const [category, confidence] = Object.entries(scores).sort((left, right) => right[1] - left[1])[0];
          detections = confidence >= this.threshold ? [{
            type: category,
            key: `jev-${category}`,
            title: TITLES[category],
            confidence,
            priority: signals.urgency,
            amountMinor: null,
            currency: null,
            eventAt: date?.dueAt || null,
            notify: true,
            details: { detector: 'jev', model: response.model || this.model, scores, urgency: signals.urgency, dueAtSource: date?.source || null },
          }] : [];
        }
      }
      this.lastSuccessAt = new Date().toISOString();
      return { ...this.status(), available: true, model: response.model || this.model, scores, signals, date, monitorScores, detections };
    } catch (error) {
      this.lastFailureAt = new Date().toISOString();
      console.warn(`Jev detection unavailable (${error?.name || 'Error'}${Number.isInteger(error?.status) ? ` ${error.status}` : ''}).`);
      return { ...this.status(), available: false, error: 'jev_unavailable', scores: {}, detections: [] };
    }
  }

  async detect(message, monitors = [], options = {}) {
    return (await this.evaluate(message?.text, monitors, { referenceAt: message?.sentAt, ...options })).detections;
  }

  async evaluateMonitor(text, monitor) {
    const result = await this.evaluate(text, [monitor], { includeBuiltIns: false });
    const confidence = probability(result.monitorScores?.[monitor?.id]);
    const threshold = boundedNumber(monitor?.threshold, this.threshold, 0.5, 0.99);
    return {
      ...result,
      matched: Boolean(result.available && confidence >= threshold),
      probability: confidence,
      threshold,
    };
  }
}

function normaliseContext(context) {
  return (Array.isArray(context) ? context : []).slice(-6).map((entry) => ({
    direction: entry?.direction === 'outgoing' ? 'outgoing' : 'incoming',
    text: String(entry?.text || '').trim().slice(0, 2_000),
  })).filter((entry) => entry.text);
}

function normaliseMessageContext(context) {
  if (!context || typeof context !== 'object') return null;
  const channel = ['gmail', 'whatsapp'].includes(context.channel) ? context.channel : null;
  const conversationKind = ['group', 'individual', 'mailbox'].includes(context.conversationKind) ? context.conversationKind : null;
  const rawHints = context.gmailHints && typeof context.gmailHints === 'object' ? context.gmailHints : null;
  const gmailHints = channel === 'gmail' && rawHints ? {
    category_promotions: Boolean(rawHints.categoryPromotions),
    has_list_unsubscribe: Boolean(rawHints.hasListUnsubscribe),
    precedence_bulk: Boolean(rawHints.precedenceBulk),
    auto_submitted: Boolean(rawHints.autoSubmitted),
  } : null;
  if (!channel && !conversationKind && !gmailHints) return null;
  return {
    ...(channel ? { channel } : {}),
    ...(conversationKind ? { conversation_kind: conversationKind } : {}),
    ...(gmailHints ? { gmail_hints: gmailHints } : {}),
  };
}

function normaliseMonitors(monitors) {
  return (Array.isArray(monitors) ? monitors : []).filter((monitor) => monitor?.kind === 'semantic'
    && typeof monitor.id === 'string' && typeof monitor.name === 'string' && typeof monitor.condition === 'string'
    && ['payment', 'meeting', 'reminder'].includes(monitor.category)).slice(0, 20).map((monitor) => ({
      id: monitor.id,
      name: monitor.name.slice(0, 80),
      condition: monitor.condition.slice(0, 500),
      category: monitor.category,
      threshold: boundedNumber(monitor.threshold, 0.78, 0.5, 0.99),
      notify: monitor.notify !== false,
    }));
}

function probability(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(Math.max(numeric, 0), 1) : 0;
}

function boundedNumber(value, fallback, minimum, maximum) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= minimum && numeric <= maximum ? numeric : fallback;
}
