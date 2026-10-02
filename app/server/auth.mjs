import crypto from 'node:crypto';

const COOKIE = 'threadmark_device';
const INVITE_TTL_DAYS = 7;

const now = () => new Date().toISOString();
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const normaliseCode = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export function constantTimeTokenMatch(candidate, expected) {
  if (!candidate || !expected) return false;
  const left = Buffer.from(String(candidate));
  const right = Buffer.from(String(expected));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function tokenFromCookie(header = '') {
  for (const part of String(header).split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return decodeURIComponent(rest.join('='));
  }
  return '';
}

export function cookieForToken(token, secure = true) {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure ? '; Secure' : ''}`;
}

export function clearCookie(secure = true) {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}

export class AuthStore {
  constructor(db, { publicBaseUrl = '' } = {}) {
    this.db = db;
    this.publicBaseUrl = publicBaseUrl;
    this.failures = [];
  }

  createInvite(label = '') {
    const code = randomCode();
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000).toISOString();
    const url = this.publicBaseUrl ? `${this.publicBaseUrl}/?invite=${encodeURIComponent(code)}` : null;
    const cleanLabel = String(label || 'My device').trim().slice(0, 80) || 'My device';
    const result = this.db.prepare(`INSERT INTO invites
      (code_hash, code, url, label, created_at, expires_at, revoked)
      VALUES (?, ?, ?, ?, ?, ?, 0)`).run(hash(normaliseCode(code)), code, url, cleanLabel, now(), expiresAt);
    return { id: Number(result.lastInsertRowid), code, url, label: cleanLabel, expires_at: expiresAt, expires_in_days: INVITE_TTL_DAYS };
  }

  listInvites() {
    return {
      ttl_days: INVITE_TTL_DAYS,
      invites: this.db.prepare(`SELECT id, label, code, url, created_at, expires_at,
        used_at, revoked, device_id FROM invites ORDER BY id DESC`).all()
        .map((row) => ({ ...row, revoked: Boolean(row.revoked) })),
    };
  }

  revokeInvite(id) {
    return this.db.prepare(`UPDATE invites SET revoked=1, code=NULL, url=NULL
      WHERE id=? AND used_at IS NULL AND revoked=0`).run(id).changes === 1;
  }

  redeemInvite(code, label = '') {
    const normalised = normaliseCode(code);
    const cutoff = Date.now() - 10 * 60_000;
    this.failures = this.failures.filter((time) => time > cutoff);
    if (this.failures.length >= 20) return { error: 'throttled' };
    if (normalised.length !== 10) return { error: 'invalid_invite' };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const invite = this.db.prepare(`SELECT id, label FROM invites WHERE code_hash=?
        AND used_at IS NULL AND revoked=0 AND expires_at>?`).get(hash(normalised), now());
      if (!invite) {
        this.db.exec('ROLLBACK');
        this.failures.push(Date.now());
        return { error: 'invalid_invite' };
      }
      const id = crypto.randomUUID();
      const token = crypto.randomBytes(32).toString('base64url');
      const cleanLabel = String(label || invite.label || 'My device').trim().slice(0, 80) || 'My device';
      this.db.prepare(`INSERT INTO devices (id, token_hash, label, created_at, last_seen, revoked)
        VALUES (?, ?, ?, ?, ?, 0)`).run(id, hash(token), cleanLabel, now(), now());
      const claim = this.db.prepare(`UPDATE invites SET used_at=?, device_id=?, code=NULL, url=NULL
        WHERE id=? AND used_at IS NULL AND revoked=0`).run(now(), id, invite.id);
      if (claim.changes !== 1) throw new Error('Invite was already redeemed');
      this.db.exec('COMMIT');
      return { token, device: { id, label: cleanLabel } };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  deviceForToken(token) {
    if (!token) return null;
    const row = this.db.prepare(`SELECT id, label, created_at, last_seen FROM devices
      WHERE token_hash=? AND revoked=0`).get(hash(token));
    if (!row) return null;
    this.db.prepare('UPDATE devices SET last_seen=? WHERE id=?').run(now(), row.id);
    return row;
  }

  listDevices() {
    return { devices: this.db.prepare(`SELECT d.id, d.label, d.created_at, d.last_seen, d.revoked,
      EXISTS(SELECT 1 FROM push_subscriptions p WHERE p.device_id=d.id) AS has_push
      FROM devices d ORDER BY d.created_at DESC`).all()
      .map((row) => ({ ...row, revoked: Boolean(row.revoked), has_push: Boolean(row.has_push) })) };
  }

  setDeviceRevoked(id, revoked) {
    return this.db.prepare('UPDATE devices SET revoked=? WHERE id=?').run(revoked ? 1 : 0, id).changes === 1;
  }

  setDeviceLabel(id, label) {
    return this.db.prepare('UPDATE devices SET label=? WHERE id=?').run(String(label || 'Device').slice(0, 80), id).changes === 1;
  }

  deleteDevice(id) {
    return this.db.prepare('DELETE FROM devices WHERE id=?').run(id).changes === 1;
  }
}

function randomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(10);
  const raw = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}
