const PAYMENT_WORDS = /\b(pay|payment|paid|owe|owes|due|transfer|bank|iban|contribution|plata|plăti|platit|plătit|dator|transfer|virament|cont|cotiza|strângem|strangem)\b/iu;
const RECEIPT_WORDS = /(?:\border receipt\b|\breceipt\b|\border confirmation\b|\bpurchase confirmation\b|\bpayment (?:confirmation|successful|received|completed)\b|\balready paid\b|\bchitan(?:ță|ta)\b|\bconfirmarea pl(?:ă|a)ții\b|\bplata (?:a fost )?(?:efectuat(?:ă|a)|finalizat(?:ă|a)|confirmat(?:ă|a))\b)/iu;
const PAYMENT_ACTION = /(?:\b(?:please|kindly) pay\b|\bpay (?:now|by|before|until)\b|\b(?:amount|balance|payment) (?:is )?due\b|\byou owe\b|\b(?:must|needs? to) be paid\b|\btransfer (?:the |this )?(?:payment|funds?|money)\b|\b(?:invoice|bill) (?:is )?(?:due|overdue|unpaid)\b|\b(?:vă|va|te) rog (?:să |sa )?(?:plătești|platesti|plata)\b|\b(?:sum(?:a|ă)|total) de plat(?:ă|a)\b|\b(?:scadent(?:ă|a)?|restant(?:ă|a)?|neachitat(?:ă|a)?)\b|\b(?:achită|achita|plătește|plateste|transferă|transfera|virați|virati)\b)/iu;
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
  const invoice = !informationalReceipt && INVOICE_WORDS.test(text) && Boolean(
    INVOICE_ACTION.test(text)
    || invoiceEvidenceNearby(text, BILLING_CONTEXT)
    || invoiceEvidenceNearby(text, AMOUNT)
    || invoiceEvidenceNearby(text, IBAN),
  );
  if (invoice) {
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
