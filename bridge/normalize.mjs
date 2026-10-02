export function normalizeMessage(message, groupName = '', resolvedContactId = '') {
  const originalSourceId = message?.key?.remoteJid;
  const sourceId = originalSourceId?.endsWith('@g.us')
    ? originalSourceId
    : canonicalPhoneId(resolvedContactId) || canonicalPhoneId(originalSourceId) || originalSourceId;
  const id = message?.key?.id;
  const sourceKind = sourceId?.endsWith('@g.us') ? 'group' : isContactId(sourceId) ? 'contact' : null;
  if (!id || !sourceKind) return null;
  const content = unwrap(message.message);
  const text = extractText(content).trim();
  const media = mediaMetadata(content);
  if (!text && !media) return null;
  const timestamp = numericTimestamp(message.messageTimestamp);
  const sourceName = sourceKind === 'group'
    ? groupName || sourceId
    : message.pushName || message.verifiedBizName || contactLabel(sourceId);
  return {
    id,
    sourceId,
    sourceName,
    sourceKind,
    senderId: message.key.fromMe ? 'self' : sourceKind === 'group' ? message.key.participant || '' : sourceId,
    senderName: message.key.fromMe ? 'You' : sourceKind === 'group' ? message.pushName || message.verifiedBizName || 'Unknown sender' : sourceName,
    sentAt: new Date(timestamp * 1000).toISOString(),
    text: text || `[${media.kind === 'audio' ? 'Voice note' : 'Attachment'}]`,
    direction: message.key.fromMe ? 'outgoing' : 'incoming',
    media,
  };
}

function mediaMetadata(content) {
  const entry = content.imageMessage ? ['image', content.imageMessage]
    : content.audioMessage ? ['audio', content.audioMessage]
      : content.documentMessage ? ['document', content.documentMessage]
        : content.videoMessage ? ['video', content.videoMessage] : null;
  if (!entry) return null;
  const [kind, media] = entry;
  return {
    kind,
    mimeType: String(media.mimetype || ''),
    fileName: String(media.fileName || '').slice(0, 240) || null,
    processed: false,
  };
}

export async function resolveContactSourceId(sourceId, getPhoneForLid) {
  const directPhoneId = canonicalPhoneId(sourceId);
  if (directPhoneId) return directPhoneId;
  if (!String(sourceId || '').endsWith('@lid') || typeof getPhoneForLid !== 'function') return sourceId;
  try {
    return canonicalPhoneId(await getPhoneForLid(sourceId)) || sourceId;
  } catch {
    return sourceId;
  }
}

function unwrap(content) {
  let current = content || {};
  for (let index = 0; index < 4; index += 1) {
    const next = current.ephemeralMessage?.message
      || current.viewOnceMessage?.message
      || current.viewOnceMessageV2?.message
      || current.documentWithCaptionMessage?.message;
    if (!next) break;
    current = next;
  }
  return current;
}

function extractText(content) {
  return content.conversation
    || content.extendedTextMessage?.text
    || content.imageMessage?.caption
    || content.videoMessage?.caption
    || content.documentMessage?.caption
    || content.buttonsResponseMessage?.selectedDisplayText
    || content.listResponseMessage?.title
    || '';
}

function numericTimestamp(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (value && typeof value.toNumber === 'function') return value.toNumber();
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Math.floor(Date.now() / 1000);
}

export function normalizeGroups(records) {
  return Object.values(records || {}).map((group) => ({
    id: group.id,
    name: group.subject || 'WhatsApp group',
    participantCount: Array.isArray(group.participants) ? group.participants.length : 0,
  })).filter((group) => group.id?.endsWith('@g.us'));
}

export function normalizeContacts(records) {
  const values = Array.isArray(records) ? records : Object.values(records || {});
  return values.map((contact) => {
    const candidateId = isContactId(contact?.phoneNumber) ? contact.phoneNumber : contact?.id;
    const id = canonicalPhoneId(candidateId) || candidateId;
    const explicitName = contact?.name || contact?.notify || contact?.verifiedName || '';
    // A bare LID is an alias, not a second person. It is emitted only when
    // WhatsApp also supplies a phone number that canonicalPhoneId can use.
    if (String(id || '').endsWith('@lid')) return null;
    return { id, name: explicitName || contactLabel(id) };
  }).filter((contact) => contact && isContactId(contact.id));
}

function isContactId(id) {
  return typeof id === 'string' && (id.endsWith('@s.whatsapp.net') || id.endsWith('@lid'));
}

function canonicalPhoneId(id) {
  const match = String(id || '').match(/^(\d+)(?::\d+)?@s\.whatsapp\.net$/u);
  return match ? `${match[1]}@s.whatsapp.net` : '';
}

function contactLabel(id) {
  const local = String(id || '').split('@')[0];
  const digits = local.replace(/\D/g, '');
  if (String(id || '').endsWith('@s.whatsapp.net') && digits) return `+${digits}`;
  return local ? `Contact ${local.slice(-6)}` : 'WhatsApp contact';
}
