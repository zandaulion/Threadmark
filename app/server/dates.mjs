const MONTHS = new Map([
  ['january', 0], ['ianuarie', 0], ['february', 1], ['februarie', 1], ['march', 2], ['martie', 2],
  ['april', 3], ['aprilie', 3], ['may', 4], ['mai', 4], ['june', 5], ['iunie', 5],
  ['july', 6], ['iulie', 6], ['august', 7], ['august', 7], ['september', 8], ['septembrie', 8],
  ['october', 9], ['octombrie', 9], ['november', 10], ['noiembrie', 10], ['december', 11], ['decembrie', 11],
]);

const WEEKDAYS = new Map([
  ['sunday', 0], ['duminica', 0], ['monday', 1], ['luni', 1], ['tuesday', 2], ['marti', 2],
  ['wednesday', 3], ['miercuri', 3], ['thursday', 4], ['joi', 4], ['friday', 5], ['vineri', 5],
  ['saturday', 6], ['sambata', 6],
]);

export function extractDueAt(text, referenceAt = new Date().toISOString()) {
  const source = fold(text);
  if (!source) return null;
  const reference = validDate(referenceAt) || new Date();
  const time = extractTime(source);
  let date = numericDate(source, reference) || namedDate(source, reference) || relativeDate(source, reference);
  if (!date) return null;
  date.setHours(time?.hour ?? 9, time?.minute ?? 0, 0, 0);
  return {
    dueAt: date.toISOString(),
    confidence: time ? 0.94 : 0.84,
    source: 'local',
    hasTime: Boolean(time),
  };
}

export function resolveJevDate(parts, referenceAt = new Date().toISOString()) {
  const reference = validDate(referenceAt) || new Date();
  const mode = parts?.mode?.choice;
  if (!['absolute', 'relative'].includes(mode)) return null;
  let date;
  if (mode === 'absolute') {
    const month = Number(parts.month?.choice);
    const day = Number(parts.day?.choice);
    let year = Number(parts.year?.choice);
    if (!Number.isInteger(year)) year = reference.getFullYear();
    if (!Number.isInteger(month) || !Number.isInteger(day)) return null;
    date = new Date(year, month - 1, day);
    if (!parts.year?.choice || parts.year.choice === 'none') {
      if (date < new Date(reference.getTime() - 31 * 86_400_000)) date.setFullYear(date.getFullYear() + 1);
    }
  } else {
    const anchor = parts.anchor?.choice;
    if (anchor === 'today') date = startOfDay(reference);
    else if (anchor === 'tomorrow') date = addDays(startOfDay(reference), 1);
    else if (anchor === 'day_after_tomorrow') date = addDays(startOfDay(reference), 2);
    else if (anchor === 'weekday') {
      const weekday = Number(parts.weekday?.choice);
      if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return null;
      const offset = parts.weekOffset?.choice === 'next' ? 7 : 0;
      date = addDays(startOfDay(reference), ((weekday - reference.getDay() + 7) % 7) + offset);
    } else return null;
  }
  if (!date || Number.isNaN(date.valueOf())) return null;
  if (mode === 'absolute' && date.getDate() !== Number(parts.day?.choice)) return null;
  const hourChoice = Number(parts.hour?.choice);
  const minuteChoice = Number(parts.minute?.choice);
  const hasTime = Number.isInteger(hourChoice) && hourChoice >= 0 && hourChoice <= 23;
  date.setHours(hasTime ? hourChoice : 9, Number.isInteger(minuteChoice) ? minuteChoice : 0, 0, 0);
  const used = ['mode', mode === 'absolute' ? 'month' : 'anchor', mode === 'absolute' ? 'day' : null, hasTime ? 'hour' : null]
    .filter(Boolean).map((key) => Number(parts[key]?.confidence)).filter(Number.isFinite);
  return { dueAt: date.toISOString(), confidence: used.length ? Math.min(...used) : 0.6, source: 'jev', hasTime };
}

function numericDate(text, reference) {
  const match = text.match(/\b(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?\b/u);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  let year = match[3] ? Number(match[3]) : reference.getFullYear();
  if (year < 100) year += 2000;
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  if (!match[3] && date < new Date(reference.getTime() - 31 * 86_400_000)) date.setFullYear(year + 1);
  return date;
}

function namedDate(text, reference) {
  const monthPattern = [...MONTHS.keys()].join('|');
  const match = text.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${monthPattern})(?:\\s+(\\d{4}))?\\b|\\b(${monthPattern})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'u'));
  if (!match) return null;
  const day = Number(match[1] || match[5]);
  const month = MONTHS.get(match[2] || match[4]);
  let year = Number(match[3] || match[6] || reference.getFullYear());
  const date = new Date(year, month, day);
  if (date.getMonth() !== month || date.getDate() !== day) return null;
  if (!match[3] && !match[6] && date < new Date(reference.getTime() - 31 * 86_400_000)) date.setFullYear(++year);
  return date;
}

function relativeDate(text, reference) {
  const day = startOfDay(reference);
  if (/\b(day after tomorrow|poimaine)\b/u.test(text)) return addDays(day, 2);
  if (/\b(tomorrow|maine)\b/u.test(text)) return addDays(day, 1);
  if (/\b(today|tonight|astazi|diseara)\b/u.test(text)) return day;
  for (const [name, weekday] of WEEKDAYS) {
    if (!new RegExp(`\\b${name}\\b`, 'u').test(text)) continue;
    const next = new RegExp(`\\b(next|viitoare|viitor)\\s+${name}|${name}\\s+(next|viitoare|viitor)\\b`, 'u').test(text);
    return addDays(day, ((weekday - reference.getDay() + 7) % 7) + (next ? 7 : 0));
  }
  return null;
}

function extractTime(text) {
  const match = text.match(/\b(?:at|ora|de la|la)?\s*([01]?\d|2[0-3])[:.]([0-5]\d)\b/u);
  if (match) return { hour: Number(match[1]), minute: Number(match[2]) };
  const ampm = text.match(/\b(?:at|ora|de la|la)\s+(1[0-2]|0?[1-9])(?:\s*:\s*([0-5]\d))?\s*(am|pm)\b/u);
  if (!ampm) return null;
  let hour = Number(ampm[1]) % 12;
  if (ampm[3] === 'pm') hour += 12;
  return { hour, minute: Number(ampm[2] || 0) };
}

function fold(value) {
  return String(value || '').trim().toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/gu, '');
}

function validDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date;
}

function startOfDay(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function addDays(value, days) {
  const date = new Date(value);
  date.setDate(date.getDate() + days);
  return date;
}
