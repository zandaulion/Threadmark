const PAYMENT_WORDS = /\b(pay|payment|paid|owe|owes|due|transfer|bank|iban|invoice|contribution|plata|plăti|platit|plătit|dator|transfer|virament|cont|factur|cotiza|strângem|strangem)\b/iu;
const MEETING_WORDS = /\b(meet|meeting|appointment|call|zoom|teams|agenda|întâln|intaln|ședin|sedin|programare|ne vedem|adunare)\b/iu;
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
  if (PAYMENT_WORDS.test(text) && (amount || iban)) {
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
