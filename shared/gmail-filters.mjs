import crypto from 'node:crypto';

export function isGitHubAddress(address) {
  const domain = String(address || '').trim().toLowerCase().split('@');
  return domain.length === 2 && Boolean(domain[0]) && (domain[1] === 'github.com' || domain[1].endsWith('.github.com'));
}

export function isIgnoredGmailSender(address, settings = {}) {
  return settings.ignoreGitHubEmails === true && isGitHubAddress(address);
}

export function knownGitHubSenderIds() {
  return ['personal', 'dev'].flatMap((profile) => ['notifications@github.com', 'noreply@github.com', 'security@github.com', 'support@github.com'].map((address) =>
    `${profile === 'dev' ? 'gmail:dev:' : 'gmail:'}sender:${crypto.createHash('sha256').update(address).digest('hex').slice(0, 32)}`));
}

export function isIgnoredGmailMessage(message, settings = {}, senderIds = knownGitHubSenderIds()) {
  return ['gmail_label', 'gmail_sender'].includes(message?.sourceKind)
    && settings.ignoreGitHubEmails === true
    && (message?.senderHints?.github === true || senderIds.includes(message?.senderId));
}

// IDs are SHA-256 sender keys; raw email addresses never enter this SQL.
export function gmailSenderVisibilitySql(settings = {}, senderIds = knownGitHubSenderIds()) {
  if (settings.ignoreGitHubEmails !== true) return '1';
  const ids = senderIds.filter(id => /^gmail:(?:dev:)?sender:[a-f0-9]{32}$/u.test(id)).map(id => `'${id}'`).join(', ');
  if (!ids) return '1';
  return `NOT (g.kind IN ('gmail_label', 'gmail_sender') AND COALESCE(m.sender_id, '') IN (${ids}))`;
}
