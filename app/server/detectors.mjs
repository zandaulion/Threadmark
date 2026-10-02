const PAYMENT_WORDS = /\b(pay|payment|paid|owe|owes|due|transfer|bank|iban|contribution|plata|plăti|platit|plătit|dator|transfer|virament|cont|cotiza|strângem|strangem)\b/iu;
const RECEIPT_WORDS = /(?:\border receipt\b|\breceipt\b|\border confirmation\b|\bpurchase confirmation\b|\bpayment (?:confirmation|successful|received|completed)\b|\balready paid\b|\bchitan(?:ță|ta)\b|\bconfirmarea pl(?:ă|a)ții\b|\bplata (?:a fost )?(?:efectuat(?:ă|a)|finalizat(?:ă|a)|confirmat(?:ă|a))\b)/iu;
const PAYMENT_ACTION = /(?:\b(?:please|kindly) pay\b|\bpay (?:now|by|before|until)\b|\b(?:amount|balance|payment) (?:is )?due\b|\byou owe\b|\b(?:must|needs? to) be paid\b|\btransfer (?:the |this )?(?:payment|funds?|money)\b|\b(?:invoice|bill) (?:is )?(?:due|overdue|unpaid)\b|\b(?:vă|va|te) rog (?:să |sa )?(?:plătești|platesti|plata)\b|\b(?:sum(?:a|ă)|total) de plat(?:ă|a)\b|\b(?:scadent(?:ă|a)?|restant(?:ă|a)?|neachitat(?:ă|a)?)\b|\b(?:achită|achita|plătește|plateste|transferă|transfera|virați|virati)\b)/iu;
const SUBSCRIPTION_CONTEXT = /\b(subscription|membership|member plan|subscribed|resubscribed|re-subscribed|abonament|subscrip(?:ție|tie))\b/iu;
const TEST_TRANSACTION = /^\s*(?:test\s*:|test (?:order|purchase|transaction)\b)/iu;
const SUBSCRIPTION_EVENTS = [
  { kind: 'payment-failed', title: 'Subscription payment failed', confidence: 0.98, priority: 0.95, pattern: /(?:\b(?:subscription|membership|abonament)[\s\S]{0,80}\b(?:payment|renewal|plata|reînnoirea|reinnoirea)[\s\S]{0,40}\b(?:failed|declined|rejected|unsuccessful|eșuat(?:ă|a)|esuat(?:ă|a)|refuzat(?:ă|a))\b|\b(?:could not|couldn['’]t|unable to) (?:process|charge)[\s\S]{0,60}\b(?:subscription|membership)\b)/iu },
  { kind: 'price-change', title: 'Subscription price changed', confidence: 0.94, priority: 0.85, pattern: /(?:\b(?:subscription|membership|abonament)[\s\S]{0,80}\b(?:price|rate|cost|preț|pret|tarif)[\s\S]{0,40}\b(?:change|changes|changing|increase|increases|crește|creste|modific)|\b(?:price|rate|cost|prețul|pretul|tariful)[\s\S]{0,50}\b(?:subscription|membership|abonament)[\s\S]{0,40}\b(?:change|increase|new|nou))/iu },
  { kind: 'expiring', title: 'Subscription expires soon', confidence: 0.93, priority: 0.82, pattern: /\b(?:subscription|membership|abonament)[\s\S]{0,60}\b(?:expires?|expiring|ends?|ending|expir(?:ă|a)|se (?:încheie|incheie))\b/iu },
  { kind: 'cancelled', title: 'Subscription cancelled', confidence: 0.95, priority: null, pattern: /(?:\b(?:subscription|membership|abonament)[\s\S]{0,60}\b(?:cancelled|canceled|terminated|anulat|oprit)|\b(?:will not|won['’]t|nu se va) (?:auto-?renew|renew|reînnoi|reinnoi)\b)/iu },
  { kind: 'renewed', title: 'Subscription renewed', confidence: 0.94, priority: null, pattern: /(?:\b(?:subscription|membership|abonament)[\s\S]{0,60}\b(?:renewed|renewal (?:confirmed|complete|successful)|reînnoit|reinnoit|reînnoirea (?:a fost )?confirmat(?:ă|a))\b|\b(?:will|scheduled to|se va) (?:auto-?renew|renew|reînnoi|reinnoi)\b)/iu },
  { kind: 'started', title: 'Subscription started', confidence: 0.93, priority: null, pattern: /(?:\b(?:subscription|membership|abonament)[\s\S]{0,60}\b(?:started|activated|active|confirmed|reactivated|început|inceput|activat|reactivat)\b|\b(?:you(?:'ve| have)?|ați|ati) (?:subscribed|resubscribed|re-subscribed)\b)/iu },
];
const MEETING_WORDS = /\b(meet|meeting|appointment|call|zoom|teams|agenda|întâln|intaln|ședin|sedin|programare|ne vedem|adunare)\b/iu;
const INVOICE_WORDS = /(?<![\p{L}\p{N}])(?:invoice(?:s)?|bill(?:s)?|billing statement|factur(?:a|ă|i|ii|e|ei|ile|ilor)|aviz(?:ul)? de plat(?:a|ă))(?![\p{L}\p{N}])/iu;
const INVOICE_ACTION = /(?:\byour\s+(?:new\s+)?(?:invoice|bill)\b|\b(?:download|view|open|pay)\s+(?:your\s+)?(?:invoice|bill)\b|\b(?:invoice|bill)\s+(?:is|was|has been)\s+(?:attached|issued|available|generated|sent|ready|due|overdue)\b|(?<![\p{L}\p{N}])factur(?:a|ă|i|ii|e|ei|ile|ilor)\s+(?:ta|dvs\.?|dumneavoastră|dumneavoastra|este|e|a fost|atașată|atasata|emisă|emisa|disponibilă|disponibila|scadentă|scadenta)(?![\p{L}\p{N}])|\b(?:descarcă|descarca|vezi|consultă|consulta|achită|achita|plătește|plateste)\s+factur(?:a|ă|ile?)(?![\p{L}\p{N}]))/iu;
const BILLING_CONTEXT = /(?<![\p{L}\p{N}])(?:gas|natural gas|gaz|gaze(?: naturale)?|electricity|electric|energy|water|internet|telecom|telephone|phone|utility|utilities|energie|electricitate|apă|apa|canalizare|salubritate|întreținere|intretinere|asigurare|insurance|rent|chirie)(?![\p{L}\p{N}])/iu;
const AMOUNT = /(?:\b(?:RON|LEI|EUR|EURO|USD)\s*)?(\d{1,6}(?:[.,]\d{1,2})?)\s*(RON|LEI|EUR|EURO|USD|€|\$)\b/iu;
const IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/u;
// Keep the separator to a colon so dotted dates such as 05.10.2026 are not
// mistaken for 05:10. Dotted times can be added later only behind an explicit
// "ora"/"at" prefix.
const TIME = /\b(?:at|ora|de la|la)?\s*([01]?\d|2[0-3]):([0-5]\d)\b/iu;
const DATE = /\b(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?\b/u;
const RELATIVE_DAY = /\b(today|tomorrow|tonight|astăzi|astazi|mâine|maine|diseară|diseara|luni|marți|marti|miercuri|joi|vineri|sâmbătă|sambata|duminică|duminica)\b/iu;

export function detectAttention(message) {
  const text = String(message.text || '').trim();
  if (!text) return [];
  const results = [];
  const amount = text.match(AMOUNT);
  const iban = text.match(IBAN);
  const informationalReceipt = isInformationalReceipt(text);
  const subscription = detectSubscription(text, amount);
  const invoice = !subscription && !informationalReceipt && INVOICE_WORDS.test(text) && Boolean(
    INVOICE_ACTION.test(text)
    || invoiceEvidenceNearby(text, BILLING_CONTEXT)
    || invoiceEvidenceNearby(text, AMOUNT)
    || invoiceEvidenceNearby(text, IBAN),
  );
  if (subscription) {
    results.push(subscription);
  } else if (invoice) {
    const currency = normaliseCurrency(amount?.[2]);
    const numeric = amount ? Number(amount[1].replace(',', '.')) : null;
    results.push({
      type: 'payment',
      key: 'invoice',
      title: amount ? `Invoice: ${amount[0].trim()}` : 'Invoice needs attention',
      confidence: amount || iban ? 0.96 : 0.9,
      amountMinor: Number.isFinite(numeric) ? Math.round(numeric * 100) : null,
      currency,
      eventAt: null,
      details: {
        invoice: true,
        amount: amount?.[0]?.trim() || null,
        iban: iban?.[0] || null,
      },
    });
  } else if (!informationalReceipt && PAYMENT_WORDS.test(text) && (amount || iban)) {
    const currency = normaliseCurrency(amount?.[2]);
    const numeric = amount ? Number(amount[1].replace(',', '.')) : null;
    results.push({
      type: 'payment',
      title: amount ? `Payment mentioned: ${amount[0].trim()}` : 'Payment details mentioned',
      confidence: amount && iban ? 0.97 : 0.87,
      amountMinor: Number.isFinite(numeric) ? Math.round(numeric * 100) : null,
      currency,
      eventAt: null,
      details: {
        amount: amount?.[0]?.trim() || null,
        iban: iban?.[0] || null,
      },
    });
  }

  const time = text.match(TIME);
  const date = text.match(DATE);
  const relative = text.match(RELATIVE_DAY);
  if (MEETING_WORDS.test(text) && (time || date || relative)) {
    results.push({
      type: 'meeting',
      title: meetingTitle(time, date, relative),
      confidence: time && (date || relative) ? 0.94 : 0.79,
      amountMinor: null,
      currency: null,
      eventAt: parseExplicitDate(date, time, message.sentAt),
      details: {
        date: date?.[0] || relative?.[0] || null,
        time: time ? `${time[1].padStart(2, '0')}:${time[2]}` : null,
        link: extractLink(text),
      },
    });
  }
  return results;
}

export function isInformationalReceipt(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  // Gmail normalization starts with the subject. Limiting receipt evidence to
  // the opening text avoids suppressing a real request that merely mentions an
  // older receipt later in a long thread or newsletter.
  return RECEIPT_WORDS.test(value.slice(0, 320)) && !PAYMENT_ACTION.test(value);
}

function detectSubscription(text, amount) {
  if (!SUBSCRIPTION_CONTEXT.test(text)) return null;
  const opening = text.slice(0, 320);
  if (TEST_TRANSACTION.test(opening) && RECEIPT_WORDS.test(opening)) return null;
  const event = SUBSCRIPTION_EVENTS.find(({ pattern }) => pattern.test(text))
    || (RECEIPT_WORDS.test(opening) ? {
      kind: 'purchased', title: 'Subscription purchased or renewed', confidence: 0.9, priority: null,
    } : null);
  if (!event) return null;
  const numeric = amount ? Number(amount[1].replace(',', '.')) : null;
  return {
    type: 'payment',
    key: `subscription-${event.kind}`,
    title: event.title,
    confidence: event.confidence,
    priority: event.priority,
    amountMinor: Number.isFinite(numeric) ? Math.round(numeric * 100) : null,
    currency: normaliseCurrency(amount?.[2]),
    eventAt: null,
    details: {
      subscription: true,
      subscriptionEvent: event.kind,
      amount: amount?.[0]?.trim() || null,
    },
  };
}

function invoiceEvidenceNearby(text, evidencePattern, radius = 160) {
  const anchors = new RegExp(INVOICE_WORDS.source, `${INVOICE_WORDS.flags.replace('g', '')}g`);
  for (const match of text.matchAll(anchors)) {
    const start = Math.max(0, match.index - radius);
    const end = Math.min(text.length, match.index + match[0].length + radius);
    if (evidencePattern.test(text.slice(start, end))) return true;
  }
  return false;
}

function normaliseCurrency(value) {
  if (!value) return null;
  const upper = value.toUpperCase();
  if (upper === 'LEI') return 'RON';
  if (upper === 'EURO' || value === '€') return 'EUR';
  if (value === '$') return 'USD';
  return upper;
}

function meetingTitle(time, date, relative) {
  const pieces = ['Meeting'];
  if (date) pieces.push(date[0]);
  else if (relative) pieces.push(relative[0]);
  if (time) pieces.push(`${time[1].padStart(2, '0')}:${time[2]}`);
  return pieces.join(' · ');
}

function parseExplicitDate(date, time, sentAt) {
  if (!date) return null;
  const base = new Date(sentAt || Date.now());
  let day = Number(date[1]);
  let month = Number(date[2]);
  if (day <= 12 && month > 12) [day, month] = [month, day];
  let year = date[3] ? Number(date[3]) : base.getUTCFullYear();
  if (year < 100) year += 2000;
  const hour = Number(time?.[1] || 9);
  const minute = Number(time?.[2] || 0);
  const parsed = new Date(Date.UTC(year, month - 1, day, hour, minute));
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

function extractLink(text) {
  return text.match(/https?:\/\/\S+/u)?.[0]?.replace(/[),.;]+$/u, '') || null;
}
