import crypto from 'node:crypto';

export function senderSourceId(address) {
  const normalized = String(address || '').trim().toLocaleLowerCase();
  if (!normalized) return null;
  return `gmail:sender:${crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 32)}`;
}

export function parseMailbox(value) {
  const decoded = decodeHeader(value);
  const bracketed = decoded.match(/^(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/u);
  const address = String(bracketed?.[2] || decoded.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu)?.[0] || '').toLocaleLowerCase();
  const name = String(bracketed?.[1] || '').replace(/^['"]|['"]$/gu, '').trim();
  return { address, name: name || address || 'Email sender' };
}

export function normalizeGmailMessage(message, source) {
  if (!message?.id || !message?.payload || !source?.id || !source?.kind) return null;
  const headers = headerMap(message.payload.headers);
  const sender = parseMailbox(headers.from);
  const subject = decodeHeader(headers.subject || '(No subject)').trim().slice(0, 500) || '(No subject)';
  const body = cleanEmailText(extractBody(message.payload));
  const text = `${subject}${body ? `\n\n${body}` : ''}`.slice(0, 65_536);
  const internalDate = Number(message.internalDate);
  return {
    id: `gmail:${message.id}`,
    sourceId: source.id,
    sourceName: source.name,
    sourceKind: source.kind,
    senderId: senderSourceId(sender.address) || 'gmail:sender:unknown',
    senderName: sender.name,
    sentAt: Number.isFinite(internalDate) ? new Date(internalDate).toISOString() : new Date().toISOString(),
    text,
    direction: 'incoming',
    externalUrl: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(message.threadId || message.id)}`,
  };
}

export function messageMetadata(message) {
  const headers = headerMap(message?.payload?.headers);
  const sender = parseMailbox(headers.from);
  return {
    id: message?.id || null,
    threadId: message?.threadId || message?.id || null,
    historyId: message?.historyId || null,
    labelIds: Array.isArray(message?.labelIds) ? message.labelIds : [],
    subject: decodeHeader(headers.subject || '(No subject)'),
    sender,
    senderSourceId: senderSourceId(sender.address),
  };
}

export function cleanEmailText(value) {
  let text = String(value || '').replace(/\r\n?/gu, '\n').replace(/\u00a0/gu, ' ');
  const cutPatterns = [
    /^On .+wrote:\s*$/imu,
    /^From:\s+.+$/imu,
    /^-{2,}\s*Original Message\s*-{2,}$/imu,
    /^_{5,}$/mu,
  ];
  let cutAt = text.length;
  for (const pattern of cutPatterns) {
    const match = pattern.exec(text);
    if (match?.index >= 0) cutAt = Math.min(cutAt, match.index);
  }
  text = text.slice(0, cutAt);
  const signature = /\n--\s*\n/u.exec(text);
  if (signature?.index >= 0) text = text.slice(0, signature.index);
  return text.split('\n').filter((line) => !/^>/.test(line.trimStart())).join('\n')
    .replace(/[ \t]+\n/gu, '\n').replace(/\n{3,}/gu, '\n\n').trim();
}

function extractBody(part) {
  if (!part) return '';
  const parts = flattenParts(part).filter((candidate) => !isAttachment(candidate));
  const plain = parts.filter((candidate) => String(candidate.mimeType || '').toLocaleLowerCase() === 'text/plain' && candidate.body?.data);
  if (plain.length) return plain.map((candidate) => decodeBase64Url(candidate.body.data, candidate.headers)).join('\n\n');
  const html = parts.filter((candidate) => String(candidate.mimeType || '').toLocaleLowerCase() === 'text/html' && candidate.body?.data);
  if (html.length) return html.map((candidate) => htmlToText(decodeBase64Url(candidate.body.data, candidate.headers))).join('\n\n');
  if (part.body?.data) return decodeBase64Url(part.body.data, part.headers);
  return '';
}

function flattenParts(part) {
  return [part, ...(Array.isArray(part.parts) ? part.parts.flatMap(flattenParts) : [])];
}

function isAttachment(part) {
  const disposition = headerMap(part?.headers)['content-disposition'] || '';
  return /^attachment\b/iu.test(disposition) || Boolean(part?.filename);
}

function decodeBase64Url(value, headers = []) {
  const bytes = Buffer.from(String(value), 'base64url');
  const contentType = headerMap(headers)['content-type'] || '';
  const charset = contentType.match(/charset=['"]?([^;'"\s]+)/iu)?.[1]?.toLocaleLowerCase();
  if (!charset || ['utf-8', 'utf8', 'us-ascii'].includes(charset)) return bytes.toString('utf8');
  try { return new TextDecoder(charset).decode(bytes); } catch { return bytes.toString('utf8'); }
}

function htmlToText(value) {
  return String(value || '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/giu, ' ')
    .replace(/<\s*br\s*\/?\s*>/giu, '\n').replace(/<\/\s*(p|div|li|tr|h[1-6])\s*>/giu, '\n')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;/giu, ' ').replace(/&amp;/giu, '&').replace(/&lt;/giu, '<').replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"').replace(/&#39;/giu, "'");
}

function headerMap(headers = []) {
  return Object.fromEntries((Array.isArray(headers) ? headers : []).map((header) => [String(header.name || '').toLocaleLowerCase(), String(header.value || '')]));
}

function decodeHeader(value) {
  return String(value || '').replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/giu, (_match, charset, encoding, data) => {
    try {
      const bytes = encoding.toLocaleLowerCase() === 'b'
        ? Buffer.from(data, 'base64')
        : Buffer.from(data.replace(/_/gu, ' ').replace(/=([0-9A-F]{2})/giu, (_hex, code) => String.fromCharCode(Number.parseInt(code, 16))), 'binary');
      return new TextDecoder(charset).decode(bytes);
    } catch { return data; }
  });
}
