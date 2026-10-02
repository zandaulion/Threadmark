import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class SecretStore {
  constructor(dataDir, key) {
    this.filename = path.join(dataDir, 'gmail-credentials.enc');
    this.key = parseKey(key);
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  }

  available() { return Boolean(this.key); }

  load() {
    if (!this.key || !fs.existsSync(this.filename)) return {};
    try {
      const envelope = JSON.parse(fs.readFileSync(this.filename, 'utf8'));
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
      const plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64url')), decipher.final()]);
      return JSON.parse(plain.toString('utf8'));
    } catch { return {}; }
  }

  save(value) {
    if (!this.key) throw new Error('GMAIL_TOKEN_ENCRYPTION_KEY must be a 32-byte base64url value');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    const envelope = JSON.stringify({ version: 1, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: data.toString('base64url') });
    const temporary = `${this.filename}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, envelope, { mode: 0o600 });
    fs.renameSync(temporary, this.filename);
  }

  clear() {
    if (fs.existsSync(this.filename)) fs.unlinkSync(this.filename);
  }
}

function parseKey(value) {
  try {
    const key = Buffer.from(String(value || ''), 'base64url');
    return key.length === 32 ? key : null;
  } catch { return null; }
}
