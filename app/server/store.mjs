import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { detectAttention } from './detectors.mjs';
import { evaluateRules, normaliseRule } from './rules.mjs';
import { extractDueAt } from './dates.mjs';
import { ensureVoiceSchema } from './voice.mjs';

const now = () => new Date().toISOString();
const DEFAULT_PROFILE_ID = 'personal';
const PROFILE_DEFINITIONS = [
  { id: 'personal', name: 'Personal', description: 'Personal WhatsApp and Gmail attention.' },
  { id: 'dev', name: 'Dev', description: 'Development projects, services, and store activity.' },
];

export function openDatabase(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(dataDir, 'threadmark.sqlite'));
  // secure_delete overwrites deleted and pruned message text instead of leaving it in free pages.
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1))
    );
    CREATE TABLE IF NOT EXISTS invites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code_hash TEXT NOT NULL UNIQUE,
      code TEXT,
      url TEXT,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),
      device_id TEXT REFERENCES devices(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      participant_count INTEGER NOT NULL DEFAULT 0,
      selected INTEGER NOT NULL DEFAULT 0 CHECK(selected IN (0,1)),
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      sender_id TEXT,
      sender_name TEXT,
      sent_at TEXT NOT NULL,
      text TEXT NOT NULL,
      direction TEXT NOT NULL DEFAULT 'incoming' CHECK(direction IN ('incoming','outgoing')),
      media_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attention_items (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('payment','meeting','reminder')),
      title TEXT NOT NULL,
      details_json TEXT NOT NULL,
      event_at TEXT,
      amount_minor INTEGER,
      currency TEXT,
      confidence REAL NOT NULL,
      priority REAL CHECK(priority IS NULL OR priority BETWEEN 0 AND 1),
      notify INTEGER NOT NULL DEFAULT 1 CHECK(notify IN (0,1)),
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done')),
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS context_messages (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('incoming','outgoing')),
      text TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      subscription_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS system_state (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'phrase' CHECK(kind IN ('phrase','semantic')),
      terms_json TEXT NOT NULL,
      semantic_condition TEXT NOT NULL DEFAULT '',
      threshold REAL NOT NULL DEFAULT 0.78 CHECK(threshold BETWEEN 0.5 AND 0.99),
      category TEXT NOT NULL CHECK(category IN ('payment','meeting','reminder')),
      match_mode TEXT NOT NULL CHECK(match_mode IN ('any','all')),
      scope TEXT NOT NULL CHECK(scope IN ('all','sources')),
      source_ids_json TEXT NOT NULL,
      notify INTEGER NOT NULL DEFAULT 1 CHECK(notify IN (0,1)),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS attention_status_idx ON attention_items(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS messages_group_idx ON messages(group_id, sent_at DESC);
    CREATE INDEX IF NOT EXISTS context_source_idx ON context_messages(source_id, sent_at DESC);
  `);
  ensureAttentionSchema(db);
  ensureMessageSchema(db);
  ensureRulesSchema(db);
  const groupColumns = db.prepare('PRAGMA table_info(groups)').all();
  if (!groupColumns.some((column) => column.name === 'kind')) {
    db.exec("ALTER TABLE groups ADD COLUMN kind TEXT NOT NULL DEFAULT 'group' CHECK(kind IN ('group','contact'))");
  }
  ensureSourceKinds(db);
  ensureProfileSchema(db);
  ensureVoiceSchema(db);
  seedProfiles(db);
  seedDevRules(db);
  db.exec('CREATE INDEX IF NOT EXISTS groups_kind_idx ON groups(profile_id, kind, selected, name)');
  const unresolved = db.prepare(`SELECT id, name FROM groups
    WHERE kind='contact' AND selected=0 AND id LIKE '%@lid'
    AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.group_id=groups.id)
    AND NOT EXISTS (SELECT 1 FROM voice_notes WHERE voice_notes.source_id=groups.id)`).all();
  const removeUnresolved = db.prepare("DELETE FROM groups WHERE id=? AND kind='contact' AND selected=0");
  for (const contact of unresolved) {
    if (/^Contact \d{6}$/u.test(contact.name)) removeUnresolved.run(contact.id);
  }
  return db;
}

export class ThreadmarkStore {
  constructor(db) {
    this.db = db;
  }

  listProfiles() {
    return this.db.prepare('SELECT id, name, description FROM profiles ORDER BY sort_order, name COLLATE NOCASE').all();
  }

  upsertGroups(groups) {
    const statement = this.db.prepare(`INSERT INTO groups (id, name, participant_count, selected, updated_at, kind, profile_id)
      VALUES (?, ?, ?, 0, ?, 'group', 'personal')
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,
        participant_count=excluded.participant_count, updated_at=excluded.updated_at, kind='group'`);
    const timestamp = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const group of groups.slice(0, 5000)) {
        if (!validGroup(group)) continue;
        statement.run(group.id, String(group.name).slice(0, 240), Number(group.participantCount || 0), timestamp);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.listGroups();
  }

  listGroups(profileId = DEFAULT_PROFILE_ID) {
    return this.db.prepare(`SELECT id, name, participant_count, selected, updated_at
      FROM groups WHERE profile_id=? AND kind='group' ORDER BY selected DESC, name COLLATE NOCASE`).all(validProfileId(profileId))
      .map((row) => ({ ...row, selected: Boolean(row.selected) }));
  }

  selectGroup(id, selected) {
    return this.db.prepare("UPDATE groups SET selected=?, updated_at=? WHERE id=? AND kind='group'")
      .run(selected ? 1 : 0, now(), id).changes === 1;
  }

  upsertContacts(contacts) {
    const statement = this.db.prepare(`INSERT INTO groups (id, name, participant_count, selected, updated_at, kind, profile_id)
      VALUES (?, ?, 0, 0, ?, 'contact', 'personal')
      ON CONFLICT(id) DO UPDATE SET name=CASE
        WHEN excluded.name LIKE '+%' AND groups.name NOT LIKE '+%' THEN groups.name
        ELSE excluded.name END, updated_at=excluded.updated_at, kind='contact'`);
    const timestamp = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const contact of contacts.slice(0, 10000)) {
        if (!validContact(contact)) continue;
        statement.run(contact.id, String(contact.name).slice(0, 240), timestamp);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.listContacts();
  }

  listContacts(profileId = DEFAULT_PROFILE_ID) {
    return this.db.prepare(`SELECT id, name, selected, updated_at
      FROM groups WHERE profile_id=? AND kind='contact' ORDER BY selected DESC, name COLLATE NOCASE`).all(validProfileId(profileId))
      .map((row) => ({ ...row, selected: Boolean(row.selected) }));
  }

  selectContact(id, selected) {
    return this.db.prepare("UPDATE groups SET selected=?, updated_at=? WHERE id=? AND kind='contact'")
      .run(selected ? 1 : 0, now(), id).changes === 1;
  }

  upsertGmailSources(sources, profileId = DEFAULT_PROFILE_ID) {
    const profile = validProfileId(profileId);
    const statement = this.db.prepare(`INSERT INTO groups (id, name, participant_count, selected, updated_at, kind, profile_id)
      VALUES (?, ?, 0, 0, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at, kind=excluded.kind`);
    const timestamp = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const source of sources.slice(0, 10_000)) {
        if (!validGmailSource(source, profile)) continue;
        statement.run(source.id, String(source.name).slice(0, 240), timestamp, source.kind, profile);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.listGmailSources(profile);
  }

  listGmailSources(profileId = DEFAULT_PROFILE_ID) {
    return this.db.prepare(`SELECT id, name, kind, selected, updated_at
      FROM groups WHERE profile_id=? AND kind IN ('gmail_label','gmail_sender') ORDER BY selected DESC, kind, name COLLATE NOCASE`).all(validProfileId(profileId))
      .map((row) => ({ ...row, selected: Boolean(row.selected) }));
  }

  selectGmailSource(id, selected, profileId = DEFAULT_PROFILE_ID) {
    return this.db.prepare("UPDATE groups SET selected=?, updated_at=? WHERE id=? AND profile_id=? AND kind IN ('gmail_label','gmail_sender')")
      .run(selected ? 1 : 0, now(), id, validProfileId(profileId)).changes === 1;
  }

  listRules({ enabledOnly = false, profileId = DEFAULT_PROFILE_ID } = {}) {
    const where = enabledOnly ? 'profile_id=? AND enabled=1' : 'profile_id=?';
    return this.db.prepare(`SELECT * FROM rules WHERE ${where} ORDER BY enabled DESC, name COLLATE NOCASE`).all(validProfileId(profileId)).map(publicRule);
  }

  createRule(input, profileId = DEFAULT_PROFILE_ID) {
    const profile = validProfileId(profileId);
    if (Number(this.db.prepare('SELECT COUNT(*) AS count FROM rules WHERE profile_id=?').get(profile).count) >= 100) {
      throw Object.assign(new Error('The rule limit of 100 has been reached.'), { status: 400 });
    }
    const rule = normaliseRule(input);
    if (rule.kind === 'semantic' && this.semanticRuleCount(profile) >= 20) {
      throw Object.assign(new Error('The semantic monitor limit of 20 has been reached.'), { status: 400 });
    }
    const id = crypto.randomUUID();
    const timestamp = now();
    this.db.prepare(`INSERT INTO rules
      (id, name, kind, terms_json, semantic_condition, threshold, category, match_mode, scope, source_ids_json, notify, enabled, created_at, updated_at, profile_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, rule.name, rule.kind, JSON.stringify(rule.terms), rule.condition, rule.threshold, rule.category, rule.matchMode, rule.scope,
      JSON.stringify(rule.sourceIds), rule.notify ? 1 : 0, rule.enabled ? 1 : 0, timestamp, timestamp, profile,
    );
    return this.ruleById(id);
  }

  updateRule(id, input) {
    const existing = this.ruleById(id);
    if (!existing) return null;
    const rule = normaliseRule(input, existing);
    if (rule.kind === 'semantic' && existing.kind !== 'semantic' && this.semanticRuleCount(existing.profileId) >= 20) {
      throw Object.assign(new Error('The semantic monitor limit of 20 has been reached.'), { status: 400 });
    }
    this.db.prepare(`UPDATE rules SET name=?, kind=?, terms_json=?, semantic_condition=?, threshold=?, category=?, match_mode=?, scope=?,
      source_ids_json=?, notify=?, enabled=?, updated_at=? WHERE id=?`).run(
      rule.name, rule.kind, JSON.stringify(rule.terms), rule.condition, rule.threshold, rule.category, rule.matchMode, rule.scope,
      JSON.stringify(rule.sourceIds), rule.notify ? 1 : 0, rule.enabled ? 1 : 0, now(), id,
    );
    return this.ruleById(id);
  }

  setRuleEnabled(id, enabled) {
    const result = this.db.prepare('UPDATE rules SET enabled=?, updated_at=? WHERE id=?').run(enabled ? 1 : 0, now(), id);
    return result.changes ? this.ruleById(id) : null;
  }

  deleteRule(id) {
    return this.db.prepare('DELETE FROM rules WHERE id=?').run(id).changes === 1;
  }

  ruleById(id) {
    const row = this.db.prepare('SELECT * FROM rules WHERE id=?').get(id);
    return row ? publicRule(row) : null;
  }

  applicableSemanticRules(message) {
    const source = sourceFromMessage(message);
    if (!source) return [];
    const profileId = profileFromMessage(message);
    return this.listRules({ enabledOnly: true, profileId }).filter((rule) => rule.kind === 'semantic'
      && (rule.scope === 'all' || rule.sourceIds.includes(source.id))).slice(0, 20);
  }

  semanticRuleCount(profileId = DEFAULT_PROFILE_ID) {
    return Number(this.db.prepare("SELECT COUNT(*) AS count FROM rules WHERE profile_id=? AND kind='semantic'").get(validProfileId(profileId)).count);
  }

  settings() {
    const defaults = {
      contextAware: false,
      outgoingMonitoring: false,
      attachmentProcessing: false,
      voiceTranscription: false,
      voiceActionDetection: false,
      dailyDigest: false,
      digestTime: '19:00',
      timeZone: 'Europe/Bucharest',
      replyDelayHours: 8,
    };
    const row = this.db.prepare("SELECT value_json FROM system_state WHERE key='preferences'").get();
    if (!row) return defaults;
    try { return { ...defaults, ...JSON.parse(row.value_json) }; } catch { return defaults; }
  }

  updateSettings(input = {}) {
    const current = this.settings();
    const digestTime = /^([01]\d|2[0-3]):[0-5]\d$/u.test(String(input.digestTime || '')) ? String(input.digestTime) : current.digestTime;
    const next = {
      contextAware: Boolean(input.contextAware),
      outgoingMonitoring: Boolean(input.outgoingMonitoring),
      attachmentProcessing: Boolean(input.attachmentProcessing),
      voiceTranscription: Boolean(input.voiceTranscription),
      voiceActionDetection: Boolean(input.voiceTranscription && input.voiceActionDetection),
      dailyDigest: Boolean(input.dailyDigest),
      digestTime,
      timeZone: validTimeZone(input.timeZone) ? String(input.timeZone) : current.timeZone,
      replyDelayHours: Math.min(Math.max(Number(input.replyDelayHours) || current.replyDelayHours, 1), 168),
    };
    this.db.prepare(`INSERT INTO system_state (key, value_json, updated_at) VALUES ('preferences', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`).run(JSON.stringify(next), now());
    if (!next.contextAware && !next.outgoingMonitoring) this.db.exec('DELETE FROM context_messages');
    return next;
  }

  routingConfig(profileId = DEFAULT_PROFILE_ID) {
    const profile = validProfileId(profileId);
    const settings = this.settings();
    return {
      profileId: profile,
      sourceIds: profile === DEFAULT_PROFILE_ID
        ? this.db.prepare("SELECT id FROM groups WHERE profile_id='personal' AND selected=1 AND kind IN ('group','contact')").all().map((row) => row.id)
        : [],
      gmailSources: this.db.prepare("SELECT id, name, kind FROM groups WHERE profile_id=? AND selected=1 AND kind IN ('gmail_label','gmail_sender')").all(profile),
      outgoingMonitoring: settings.outgoingMonitoring,
      attachmentProcessing: settings.attachmentProcessing,
      voiceTranscription: settings.voiceTranscription,
      voiceActionDetection: settings.voiceActionDetection,
    };
  }

  detectMessage(message) {
    const source = sourceFromMessage(message);
    if (!source) return [];
    return [...detectAttention(message), ...evaluateRules(message, source, this.listRules({ enabledOnly: true, profileId: profileFromMessage(message) }))];
  }

  participantCount(groupId) {
    return Number(this.db.prepare("SELECT participant_count FROM groups WHERE id=? AND kind='group'").get(groupId)?.participant_count) || 0;
  }

  isSelectedMessage(message) {
    const source = sourceFromMessage(message);
    if (!source) return { selected: false, source: null };
    const profileId = profileFromMessage(message);
    return {
      selected: Boolean(this.db.prepare('SELECT selected FROM groups WHERE id=? AND kind=? AND profile_id=?').get(source.id, source.kind, profileId)?.selected),
      source,
      profileId,
    };
  }

  ingestMessage(message, additionalDetections = [], options = {}) {
    const source = sourceFromMessage(message);
    if (!message || typeof message.id !== 'string' || !source) {
      return { accepted: false, reason: 'invalid' };
    }
    const profileId = profileFromMessage(message);
    const knownSource = this.db.prepare('SELECT selected FROM groups WHERE id=? AND kind=? AND profile_id=?').get(source.id, source.kind, profileId);
    if (!knownSource) {
      if (source.kind === 'group') this.upsertGroups([{ id: source.id, name: source.name, participantCount: 0 }]);
      else if (source.kind === 'contact') this.upsertContacts([{ id: source.id, name: source.name }]);
      else this.upsertGmailSources([{ id: source.id, name: source.name, kind: source.kind }], profileId);
    } else if (source.kind === 'contact' && source.name) {
      this.upsertContacts([{ id: source.id, name: source.name }]);
    }
    const selected = this.db.prepare('SELECT selected FROM groups WHERE id=? AND kind=? AND profile_id=?').get(source.id, source.kind, profileId)?.selected;
    if (!selected) return { accepted: false, reason: 'not_selected', sourceKind: source.kind };
    const detections = this.enrichDetections(message, source, [
      ...(options.includeLocal === false ? [] : this.detectMessage(message)),
      ...(Array.isArray(additionalDetections) ? additionalDetections : []),
    ]);
    if (!detections.length) return { accepted: true, items: [], sourceKind: source.kind };

    const insertedItems = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const inserted = this.db.prepare(`INSERT INTO messages
        (id, group_id, sender_id, sender_name, sent_at, text, direction, media_json, external_url, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`).run(
          message.id,
          source.id,
          String(message.senderId || '').slice(0, 160),
          String(message.senderName || 'Unknown sender').slice(0, 160),
          safeIso(message.sentAt),
          String(message.text || '').slice(0, 65_536),
          message.direction === 'outgoing' ? 'outgoing' : 'incoming',
          JSON.stringify(normaliseMedia(message.media)),
          safeExternalUrl(message.externalUrl),
          now(),
        );
      if (inserted.changes === 0) {
        this.db.exec('COMMIT');
        return { accepted: true, duplicate: true, items: [], sourceKind: source.kind };
      }
      const addItem = this.db.prepare(`INSERT INTO attention_items
        (id, message_id, type, title, details_json, event_at, amount_minor, currency, confidence, priority, notify, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`);
      for (const detection of detections) {
        const id = `${message.id}:${detection.key || detection.type}`;
        addItem.run(id, message.id, detection.type, detection.title, JSON.stringify(detection.details), detection.eventAt,
          detection.amountMinor, detection.currency, detection.confidence,
          Number.isFinite(detection.priority) ? Math.min(Math.max(detection.priority, 0), 1) : null,
          detection.notify === false ? 0 : 1, now());
        insertedItems.push(this.itemById(id));
      }
      this.db.exec('COMMIT');
      return { accepted: true, items: insertedItems, sourceKind: source.kind };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  enrichDetections(message, source, detections) {
    const unique = new Map();
    const localDate = extractDueAt(message.text, message.sentAt, { requireAction: true });
    for (const raw of detections) {
      if (!raw || !['payment', 'meeting', 'reminder'].includes(raw.type)) continue;
      const detection = { ...raw, details: { ...(raw.details || {}) } };
      if (!detection.eventAt && !detection.details.dateEvaluated && localDate) {
        detection.eventAt = localDate.dueAt;
        detection.details.dueAtSource = localDate.source;
        detection.details.dueAtConfidence = localDate.confidence;
      }
      if (detection.type === 'payment') this.addPaymentSafety(source, message, detection);
      unique.set(detection.key || detection.type, detection);
    }
    return [...unique.values()];
  }

  addPaymentSafety(source, message, detection) {
    if (detection.details?.attentionTriage?.disposition === 'promotional') return;
    const alerts = [];
    const text = String(message.text || '');
    const currentIban = detection.details?.iban || text.match(/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/u)?.[0] || null;
    const gmail = ['gmail_label', 'gmail_sender'].includes(source.kind);
    const senderId = String(message.senderId || '').slice(0, 160);
    const priorScope = gmail ? 'g.profile_id=? AND m.sender_id=?' : "g.id=? AND COALESCE(m.sender_id, '')=?";
    const previous = !senderId ? null : this.db.prepare(`${itemSelect()} WHERE ${priorScope} AND a.type='payment'
      AND COALESCE(a.feedback, '')!='not_relevant'
      AND COALESCE(json_extract(a.details_json, '$.attentionTriage.disposition'), '')!='promotional'
      ORDER BY a.created_at DESC LIMIT 1`).get(gmail ? profileFromMessage(message) : source.id, senderId);
    const previousDetails = previous ? safeJson(previous.details_json) : {};
    if (!detection.details?.subscription) {
      if (currentIban && previousDetails.iban && currentIban !== previousDetails.iban) alerts.push('Bank details changed since the previous payment request');
      if (previous && detection.amountMinor && previous.amount_minor === detection.amountMinor
        && (!currentIban || !previousDetails.iban || currentIban === previousDetails.iban)
        && Date.now() - new Date(previous.created_at).valueOf() < 14 * 86_400_000) alerts.push('Possible duplicate payment request');
      if (previous && detection.amountMinor && previous.amount_minor && previous.amount_minor !== detection.amountMinor) alerts.push('Amount differs from the previous payment request');
    }
    if (/\b(password|pin|otp|one[- ]time code|cod(?:ul)? sms|parola|cvv|gift card|card cadou|crypto|bitcoin|remote access|anydesk|teamviewer|secret|confidential|nu spune)\b/iu.test(text)) {
      alerts.push('Unusual payment request—verify through another channel');
    }
    if (alerts.length) {
      detection.details.safetyAlerts = [...new Set(alerts)];
      detection.priority = Math.max(Number(detection.priority) || 0, 0.9);
    }
  }

  recordContextMessage(message) {
    const source = sourceFromMessage(message);
    if (!source || !this.isSelectedMessage(message).selected) return false;
    const text = String(message.text || '').trim().slice(0, 4_000);
    if (!text) return false;
    const sentAt = safeIso(message.sentAt);
    const expiresAt = new Date(new Date(sentAt).valueOf() + 48 * 3_600_000).toISOString();
    this.db.prepare(`INSERT INTO context_messages (id, source_id, direction, text, sent_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`).run(
      String(message.id).slice(0, 240), source.id, message.direction === 'outgoing' ? 'outgoing' : 'incoming', text, sentAt, expiresAt,
    );
    return true;
  }

  recentContext(message, limit = 6) {
    const source = sourceFromMessage(message);
    if (!source) return [];
    return this.db.prepare(`SELECT direction, text, sent_at AS sentAt FROM context_messages
      WHERE source_id=? AND expires_at>? ORDER BY sent_at DESC LIMIT ?`).all(source.id, now(), Math.min(Math.max(limit, 1), 10)).reverse();
  }

  applyContextSignals(message, analysis) {
    const source = sourceFromMessage(message);
    if (!source) return [];
    const updates = [];
    const signals = analysis?.signals || {};
    const prior = this.db.prepare(`${itemSelect()} WHERE g.id=? AND a.status='open' ORDER BY a.created_at DESC LIMIT 1`).get(source.id);
    if (!prior) return updates;
    if (signals.cancelsPrevious >= 0.86) {
      const details = { ...safeJson(prior.details_json), cancelledByFollowUp: true, contextProbability: signals.cancelsPrevious };
      this.db.prepare("UPDATE attention_items SET status='done', resolved_at=?, details_json=? WHERE id=?").run(now(), JSON.stringify(details), prior.id);
      updates.push(this.itemById(prior.id));
    } else if (signals.changesPrevious >= 0.82) {
      const details = { ...safeJson(prior.details_json), changedByFollowUp: true, contextProbability: signals.changesPrevious, latestUpdate: String(message.text || '').slice(0, 1000) };
      this.db.prepare('UPDATE attention_items SET event_at=COALESCE(?, event_at), details_json=? WHERE id=?')
        .run(analysis.date?.dueAt || null, JSON.stringify(details), prior.id);
      updates.push(this.itemById(prior.id));
    }
    return updates;
  }

  markSourceReplied(message) {
    const source = sourceFromMessage(message);
    if (!source) return [];
    const rows = this.db.prepare(`${itemSelect()} WHERE g.id=? AND a.status='open' ORDER BY a.created_at DESC`).all(source.id);
    const changed = [];
    for (const row of rows) {
      const details = safeJson(row.details_json);
      if (!details.awaitingReply) continue;
      details.repliedAt = safeIso(message.sentAt);
      this.db.prepare("UPDATE attention_items SET status='done', resolved_at=?, details_json=? WHERE id=?")
        .run(now(), JSON.stringify(details), row.id);
      changed.push(this.itemById(row.id));
    }
    return changed;
  }

  hasMessage(id) {
    return typeof id === 'string' && Boolean(this.db.prepare('SELECT 1 FROM messages WHERE id=?').get(id));
  }

  listItems({ status = 'open', type = 'all', limit = 100, profileId = DEFAULT_PROFILE_ID } = {}) {
    const clauses = ['g.profile_id=?'];
    const values = [validProfileId(profileId)];
    const promotional = "COALESCE(json_extract(a.details_json, '$.attentionTriage.disposition'), '')='promotional'";
    if (status === 'open') clauses.push(`a.status='open' AND NOT (${promotional}) AND (a.snoozed_until IS NULL OR datetime(a.snoozed_until)<=datetime('now'))`);
    else if (status === 'snoozed') clauses.push(`a.status='open' AND NOT (${promotional}) AND datetime(a.snoozed_until)>datetime('now')`);
    else if (status === 'promotional') clauses.push(`a.status='open' AND ${promotional}`);
    else if (status !== 'all') { clauses.push('a.status=?'); values.push(status); }
    if (type !== 'all') { clauses.push('a.type=?'); values.push(type); }
    values.push(Math.min(Math.max(Number(limit) || 100, 1), 200));
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const orderBy = status === 'done'
      ? 'a.resolved_at DESC, a.created_at DESC'
      : status === 'snoozed'
        ? 'a.snoozed_until ASC, a.created_at DESC'
        : status === 'promotional'
          ? "json_extract(a.details_json, '$.attentionTriage.promotional') DESC, a.created_at DESC"
          : 'CASE WHEN COALESCE(a.priority, 0)>=0.78 THEN 1 ELSE 0 END DESC, a.created_at DESC';
    return this.db.prepare(`${itemSelect()} ${where}
      ORDER BY ${orderBy} LIMIT ?`).all(...values).map(publicItem);
  }

  itemById(id) {
    const row = this.db.prepare(`${itemSelect()} WHERE a.id=?`).get(id);
    return row ? publicItem(row) : null;
  }

  setItemStatus(id, status) {
    if (!['open', 'done'].includes(status)) return null;
    const result = this.db.prepare(`UPDATE attention_items SET status=?, resolved_at=? WHERE id=?`)
      .run(status, status === 'done' ? now() : null, id);
    return result.changes ? this.itemById(id) : null;
  }

  setItemFeedback(id, input = {}) {
    const item = this.itemById(id);
    if (!item) return null;
    const feedback = ['useful', 'not_relevant', 'wrong_category'].includes(input.feedback) ? input.feedback : null;
    if (!feedback) return null;
    const category = ['payment', 'meeting', 'reminder'].includes(input.category) ? input.category : item.type;
    const nextStatus = feedback === 'not_relevant' ? 'done' : item.status;
    const details = { ...(item.details || {}) };
    if (feedback === 'useful' && details.attentionTriage?.disposition === 'promotional') {
      details.attentionTriage = { ...details.attentionTriage, disposition: 'inbox', restoredByFeedback: true };
    }
    this.db.prepare(`UPDATE attention_items SET feedback=?, feedback_at=?, type=?, status=?, details_json=?, resolved_at=CASE WHEN ?='done' THEN ? ELSE resolved_at END
      WHERE id=?`).run(feedback, now(), feedback === 'wrong_category' ? category : item.type, nextStatus, JSON.stringify(details), nextStatus, now(), id);
    this.db.prepare('INSERT INTO audit_events (action, detail, created_at) VALUES (?, ?, ?)')
      .run('item_feedback', JSON.stringify({ itemId: id, feedback, category: feedback === 'wrong_category' ? category : null }), now());
    return this.itemById(id);
  }

  snoozeItem(id, until) {
    const parsed = new Date(until);
    if (Number.isNaN(parsed.valueOf()) || parsed <= new Date() || parsed > new Date(Date.now() + 366 * 86_400_000)) return null;
    const changed = this.db.prepare("UPDATE attention_items SET snoozed_until=?, last_notified_at=NULL WHERE id=? AND status='open'")
      .run(parsed.toISOString(), id).changes;
    return changed ? this.itemById(id) : null;
  }

  dueNotifications() {
    return this.db.prepare(`${itemSelect()} WHERE a.status='open'
      AND COALESCE(json_extract(a.details_json, '$.attentionTriage.disposition'), '')!='promotional' AND (
      (a.snoozed_until IS NOT NULL AND datetime(a.snoozed_until)<=datetime('now') AND a.last_notified_at IS NULL)
      OR (a.event_at IS NOT NULL AND a.event_at<=datetime('now', '+1 hour') AND a.event_at>datetime('now', '-12 hours')
        AND (a.last_notified_at IS NULL OR datetime(a.last_notified_at)<datetime(a.event_at, '-1 hour')))
    ) ORDER BY COALESCE(a.snoozed_until, a.event_at) LIMIT 50`).all().map(publicItem);
  }

  markNotified(id) {
    this.db.prepare('UPDATE attention_items SET last_notified_at=? WHERE id=?').run(now(), id);
  }

  digestDue(date = new Date(), profileId = DEFAULT_PROFILE_ID) {
    const settings = this.settings();
    if (!settings.dailyDigest) return false;
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: settings.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map((part) => [part.type, part.value]));
    const localDay = `${parts.year}-${parts.month}-${parts.day}`;
    const currentMinutes = Number(parts.hour) * 60 + Number(parts.minute);
    const [hour, minute] = settings.digestTime.split(':').map(Number);
    if (currentMinutes < hour * 60 + minute || currentMinutes > hour * 60 + minute + 5) return false;
    const row = this.db.prepare('SELECT value_json FROM system_state WHERE key=?').get(`last_digest_day:${validProfileId(profileId)}`);
    return safeJson(row?.value_json).day !== localDay ? localDay : false;
  }

  markDigestSent(day, profileId = DEFAULT_PROFILE_ID) {
    this.db.prepare(`INSERT INTO system_state (key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`)
      .run(`last_digest_day:${validProfileId(profileId)}`, JSON.stringify({ day }), now());
  }

  summary(profileId = DEFAULT_PROFILE_ID) {
    const profile = validProfileId(profileId);
    const rows = this.db.prepare(`SELECT a.type, COUNT(*) AS count FROM attention_items a
      JOIN messages m ON m.id=a.message_id JOIN groups g ON g.id=m.group_id
      WHERE g.profile_id=? AND a.status='open' AND COALESCE(json_extract(a.details_json, '$.attentionTriage.disposition'), '')!='promotional'
      AND (a.snoozed_until IS NULL OR datetime(a.snoozed_until)<=datetime('now')) GROUP BY a.type`).all(profile);
    const summary = { open: 0, payments: 0, meetings: 0, reminders: 0, snoozed: 0, promotional: 0, groups: 0, contacts: 0, gmail: 0 };
    for (const row of rows) {
      summary.open += Number(row.count);
      if (row.type === 'payment') summary.payments = Number(row.count);
      if (row.type === 'meeting') summary.meetings = Number(row.count);
      if (row.type === 'reminder') summary.reminders = Number(row.count);
    }
    summary.groups = Number(this.db.prepare("SELECT COUNT(*) AS count FROM groups WHERE profile_id=? AND selected=1 AND kind='group'").get(profile).count);
    summary.contacts = Number(this.db.prepare("SELECT COUNT(*) AS count FROM groups WHERE profile_id=? AND selected=1 AND kind='contact'").get(profile).count);
    summary.gmail = Number(this.db.prepare("SELECT COUNT(*) AS count FROM groups WHERE profile_id=? AND selected=1 AND kind IN ('gmail_label','gmail_sender')").get(profile).count);
    summary.snoozed = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM attention_items a JOIN messages m ON m.id=a.message_id JOIN groups g ON g.id=m.group_id
      WHERE g.profile_id=? AND a.status='open' AND COALESCE(json_extract(a.details_json, '$.attentionTriage.disposition'), '')!='promotional'
      AND datetime(a.snoozed_until)>datetime('now')`).get(profile).count);
    summary.promotional = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM attention_items a JOIN messages m ON m.id=a.message_id JOIN groups g ON g.id=m.group_id
      WHERE g.profile_id=? AND a.status='open' AND json_extract(a.details_json, '$.attentionTriage.disposition')='promotional'`).get(profile).count);
    return summary;
  }

  saveSubscription(deviceId, subscription) {
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) return false;
    this.db.prepare(`INSERT INTO push_subscriptions (endpoint, device_id, subscription_json, created_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET device_id=excluded.device_id,
      subscription_json=excluded.subscription_json`).run(subscription.endpoint, deviceId, JSON.stringify(subscription), now());
    return true;
  }

  subscriptions() {
    return this.db.prepare('SELECT endpoint, subscription_json FROM push_subscriptions').all()
      .map((row) => ({ endpoint: row.endpoint, subscription: JSON.parse(row.subscription_json) }));
  }

  removeSubscription(endpoint) {
    this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(endpoint);
  }

  setBridgeStatus(status) {
    const safe = {
      connection: ['connected', 'connecting', 'disconnected', 'pairing'].includes(status?.connection) ? status.connection : 'disconnected',
      account: status?.account ? String(status.account).slice(0, 120) : null,
      lastEventAt: status?.lastEventAt ? safeIso(status.lastEventAt) : now(),
    };
    this.db.prepare(`INSERT INTO system_state (key, value_json, updated_at) VALUES ('bridge', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`)
      .run(JSON.stringify(safe), now());
    return safe;
  }

  bridgeStatus() {
    const row = this.db.prepare("SELECT value_json, updated_at FROM system_state WHERE key='bridge'").get();
    return row ? { ...JSON.parse(row.value_json), updatedAt: row.updated_at } : { connection: 'disconnected', account: null, updatedAt: null };
  }

  prune(days) {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    this.db.prepare('DELETE FROM context_messages WHERE expires_at<=?').run(now());
    this.db.prepare('DELETE FROM voice_notes WHERE created_at<?').run(cutoff);
    return this.db.prepare(`DELETE FROM messages WHERE created_at<? AND id NOT IN
      (SELECT message_id FROM attention_items WHERE status='open')`).run(cutoff).changes;
  }
}

function itemSelect() {
  return `SELECT a.id, a.type, a.title, a.details_json, a.event_at, a.amount_minor,
    a.currency, a.confidence, a.priority, a.notify, a.status, a.created_at, a.resolved_at,
    a.snoozed_until, a.last_notified_at, a.feedback, a.feedback_at,
    m.text, m.sender_name, m.sent_at, m.direction, m.media_json, m.external_url,
    g.id AS source_id, g.name AS source_name, g.kind AS source_kind, g.profile_id,
    p.name AS profile_name
    FROM attention_items a JOIN messages m ON m.id=a.message_id
    JOIN groups g ON g.id=m.group_id JOIN profiles p ON p.id=g.profile_id`;
}

function publicItem(row) {
  const details = JSON.parse(row.details_json);
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    details,
    detectionSource: details?.detector === 'jev' ? 'jev' : details?.detector === 'review' ? 'review' : 'rule',
    eventAt: row.event_at,
    amountMinor: row.amount_minor,
    currency: row.currency,
    confidence: row.confidence,
    priority: row.priority === null || row.priority === undefined ? null : Number(row.priority),
    notify: Boolean(row.notify),
    status: row.status,
    snoozedUntil: row.snoozed_until,
    feedback: row.feedback,
    feedbackAt: row.feedback_at,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    text: row.text,
    senderName: row.sender_name,
    sentAt: row.sent_at,
    direction: row.direction || 'incoming',
    media: safeJson(row.media_json),
    externalUrl: row.external_url || null,
    profile: { id: row.profile_id || DEFAULT_PROFILE_ID, name: row.profile_name || 'Personal' },
    source: { id: row.source_id, name: row.source_name, kind: row.source_kind },
    group: { id: row.source_id, name: row.source_name, kind: row.source_kind },
  };
}

function publicRule(row) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind || 'phrase',
    terms: JSON.parse(row.terms_json),
    condition: row.semantic_condition || '',
    threshold: Number(row.threshold ?? 0.78),
    category: row.category,
    matchMode: row.match_mode,
    scope: row.scope,
    sourceIds: JSON.parse(row.source_ids_json),
    notify: Boolean(row.notify),
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    profileId: row.profile_id || DEFAULT_PROFILE_ID,
  };
}

function ensureProfileSchema(db) {
  const sourceColumns = db.prepare('PRAGMA table_info(groups)').all();
  if (!sourceColumns.some((column) => column.name === 'profile_id')) {
    db.exec("ALTER TABLE groups ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'personal'");
  }
  const ruleColumns = db.prepare('PRAGMA table_info(rules)').all();
  if (!ruleColumns.some((column) => column.name === 'profile_id')) {
    db.exec("ALTER TABLE rules ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'personal'");
  }
  db.exec('CREATE INDEX IF NOT EXISTS rules_profile_idx ON rules(profile_id, enabled, name)');
}

function seedProfiles(db) {
  const insert = db.prepare(`INSERT INTO profiles (id, name, description, sort_order, created_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, sort_order=excluded.sort_order`);
  const timestamp = now();
  PROFILE_DEFINITIONS.forEach((profile, index) => insert.run(profile.id, profile.name, profile.description, index, timestamp));
}

function seedDevRules(db) {
  const marker = db.prepare("SELECT 1 FROM system_state WHERE key='dev_rules_seeded_v1'").get();
  if (marker) return;
  const existing = Number(db.prepare("SELECT COUNT(*) AS count FROM rules WHERE profile_id='dev'").get().count);
  if (existing) {
    db.prepare("INSERT INTO system_state (key, value_json, updated_at) VALUES ('dev_rules_seeded_v1', '{}', ?)").run(now());
    return;
  }
  const presets = [
    ['Dev security or access change', 'A security, authentication, permission, key, token, vulnerability, or account-access change affects a development project or service I own.', 0.8],
    ['Build or deployment failure', 'A build, test, deployment, release, production service, certificate, domain, or integration failed or is blocked and requires intervention.', 0.82],
    ['Store or policy action', 'An app store, developer platform, or service provider requires action to avoid rejection, suspension, expiration, policy non-compliance, or service interruption.', 0.8],
    ['Review or reply requested', 'A person directly asks me to review code, make a technical decision, provide information, or reply about a development project.', 0.82],
    ['User issue needs attention', 'A real user or tester reports a bug, failed purchase, refund problem, account problem, or other product issue that deserves a response.', 0.82],
  ];
  const insert = db.prepare(`INSERT INTO rules
    (id, name, kind, terms_json, semantic_condition, threshold, category, match_mode, scope, source_ids_json, notify, enabled, created_at, updated_at, profile_id)
    VALUES (?, ?, 'semantic', '[]', ?, ?, 'reminder', 'any', 'all', '[]', 1, 1, ?, ?, 'dev')`);
  const timestamp = now();
  for (const [name, condition, threshold] of presets) {
    insert.run(`dev-preset-${crypto.createHash('sha256').update(name).digest('hex').slice(0, 16)}`, name, condition, threshold, timestamp, timestamp);
  }
  db.prepare("INSERT INTO system_state (key, value_json, updated_at) VALUES ('dev_rules_seeded_v1', '{}', ?)").run(timestamp);
}

function ensureRulesSchema(db) {
  const columns = db.prepare('PRAGMA table_info(rules)').all();
  if (!columns.some((column) => column.name === 'kind')) {
    db.exec("ALTER TABLE rules ADD COLUMN kind TEXT NOT NULL DEFAULT 'phrase' CHECK(kind IN ('phrase','semantic'))");
  }
  if (!columns.some((column) => column.name === 'semantic_condition')) {
    db.exec("ALTER TABLE rules ADD COLUMN semantic_condition TEXT NOT NULL DEFAULT ''");
  }
  if (!columns.some((column) => column.name === 'threshold')) {
    db.exec('ALTER TABLE rules ADD COLUMN threshold REAL NOT NULL DEFAULT 0.78 CHECK(threshold BETWEEN 0.5 AND 0.99)');
  }
}

function ensureAttentionSchema(db) {
  const sql = String(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='attention_items'").get()?.sql || '');
  if (!sql.includes("'reminder'")) {
    db.exec(`
      PRAGMA foreign_keys=OFF;
      BEGIN IMMEDIATE;
      ALTER TABLE attention_items RENAME TO attention_items_legacy;
      CREATE TABLE attention_items (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK(type IN ('payment','meeting','reminder')),
        title TEXT NOT NULL,
        details_json TEXT NOT NULL,
        event_at TEXT,
        amount_minor INTEGER,
        currency TEXT,
        confidence REAL NOT NULL,
        priority REAL CHECK(priority IS NULL OR priority BETWEEN 0 AND 1),
        notify INTEGER NOT NULL DEFAULT 1 CHECK(notify IN (0,1)),
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done')),
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      INSERT INTO attention_items
        (id, message_id, type, title, details_json, event_at, amount_minor, currency, confidence, priority, notify, status, created_at, resolved_at)
        SELECT id, message_id, type, title, details_json, event_at, amount_minor, currency, confidence, NULL, 1, status, created_at, resolved_at
        FROM attention_items_legacy;
      DROP TABLE attention_items_legacy;
      CREATE INDEX attention_status_idx ON attention_items(status, created_at DESC);
      COMMIT;
      PRAGMA foreign_keys=ON;
    `);
  }
  const columns = db.prepare('PRAGMA table_info(attention_items)').all();
  if (!columns.some((column) => column.name === 'notify')) db.exec('ALTER TABLE attention_items ADD COLUMN notify INTEGER NOT NULL DEFAULT 1 CHECK(notify IN (0,1))');
  if (!columns.some((column) => column.name === 'priority')) db.exec('ALTER TABLE attention_items ADD COLUMN priority REAL CHECK(priority IS NULL OR priority BETWEEN 0 AND 1)');
  if (!columns.some((column) => column.name === 'snoozed_until')) db.exec('ALTER TABLE attention_items ADD COLUMN snoozed_until TEXT');
  if (!columns.some((column) => column.name === 'last_notified_at')) db.exec('ALTER TABLE attention_items ADD COLUMN last_notified_at TEXT');
  if (!columns.some((column) => column.name === 'feedback')) db.exec('ALTER TABLE attention_items ADD COLUMN feedback TEXT');
  if (!columns.some((column) => column.name === 'feedback_at')) db.exec('ALTER TABLE attention_items ADD COLUMN feedback_at TEXT');
}

function ensureMessageSchema(db) {
  const columns = db.prepare('PRAGMA table_info(messages)').all();
  if (!columns.some((column) => column.name === 'direction')) {
    db.exec("ALTER TABLE messages ADD COLUMN direction TEXT NOT NULL DEFAULT 'incoming' CHECK(direction IN ('incoming','outgoing'))");
  }
  if (!columns.some((column) => column.name === 'media_json')) db.exec("ALTER TABLE messages ADD COLUMN media_json TEXT NOT NULL DEFAULT '{}'");
  if (!columns.some((column) => column.name === 'external_url')) db.exec('ALTER TABLE messages ADD COLUMN external_url TEXT');
}

function ensureSourceKinds(db) {
  const sql = String(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='groups'").get()?.sql || '');
  if (sql.includes('gmail_label') && sql.includes('gmail_sender')) return;
  db.exec(`
    PRAGMA foreign_keys=OFF;
    PRAGMA legacy_alter_table=ON;
    BEGIN IMMEDIATE;
    ALTER TABLE groups RENAME TO groups_legacy;
    CREATE TABLE groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      participant_count INTEGER NOT NULL DEFAULT 0,
      selected INTEGER NOT NULL DEFAULT 0 CHECK(selected IN (0,1)),
      updated_at TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'group' CHECK(kind IN ('group','contact','gmail_label','gmail_sender'))
    );
    INSERT INTO groups (id, name, participant_count, selected, updated_at, kind)
      SELECT id, name, participant_count, selected, updated_at, kind FROM groups_legacy;
    DROP TABLE groups_legacy;
    COMMIT;
    PRAGMA legacy_alter_table=OFF;
    PRAGMA foreign_keys=ON;
  `);
}

function validGroup(group) {
  return group && typeof group.id === 'string' && group.id.endsWith('@g.us') && typeof group.name === 'string';
}

function validContact(contact) {
  return contact && typeof contact.id === 'string' && isContactId(contact.id) && typeof contact.name === 'string';
}

function validGmailSource(source, profileId = DEFAULT_PROFILE_ID) {
  const prefix = gmailSourcePrefix(profileId, source?.kind);
  return source && ['gmail_label', 'gmail_sender'].includes(source.kind)
    && typeof source.id === 'string' && source.id.startsWith(prefix)
    && typeof source.name === 'string' && source.name.trim();
}

function isContactId(id) {
  return id.endsWith('@s.whatsapp.net') || id.endsWith('@lid');
}

function sourceFromMessage(message) {
  if (!message || typeof message !== 'object') return null;
  const id = message.sourceId || message.groupId;
  const inferredKind = typeof id === 'string' && id.endsWith('@g.us') ? 'group' : isContactId(String(id || '')) ? 'contact' : null;
  const kind = message.sourceKind || inferredKind;
  const name = String(message.sourceName || message.groupName || message.senderName || (kind === 'group' ? 'WhatsApp group' : contactLabel(id)));
  if (kind === 'group' && validGroup({ id, name })) return { id, name, kind };
  if (kind === 'contact' && validContact({ id, name })) return { id, name, kind };
  if (validGmailSource({ id, name, kind }, profileFromMessage(message))) return { id, name, kind };
  return null;
}

function profileFromMessage(message) {
  if (['group', 'contact'].includes(message?.sourceKind)) return DEFAULT_PROFILE_ID;
  const requested = String(message?.profileId || DEFAULT_PROFILE_ID);
  return validProfileId(requested);
}

function validProfileId(value) {
  return PROFILE_DEFINITIONS.some((profile) => profile.id === value) ? value : DEFAULT_PROFILE_ID;
}

function gmailSourcePrefix(profileId, kind) {
  const namespace = validProfileId(profileId) === DEFAULT_PROFILE_ID ? 'gmail:' : `gmail:${validProfileId(profileId)}:`;
  return `${namespace}${kind === 'gmail_label' ? 'label' : 'sender'}:`;
}

function contactLabel(id) {
  const digits = String(id || '').split('@')[0].replace(/\D/g, '');
  return digits ? `+${digits}` : 'WhatsApp contact';
}

function safeIso(value) {
  const date = new Date(value || Date.now());
  return Number.isNaN(date.valueOf()) ? now() : date.toISOString();
}

function safeJson(value) {
  try { return typeof value === 'string' ? JSON.parse(value) : value || {}; } catch { return {}; }
}

function safeExternalUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && url.hostname === 'mail.google.com' ? url.toString().slice(0, 1000) : null;
  } catch { return null; }
}

function normaliseMedia(media) {
  if (!media || typeof media !== 'object') return {};
  return {
    kind: ['image', 'document', 'audio', 'video'].includes(media.kind) ? media.kind : null,
    fileName: String(media.fileName || '').slice(0, 240) || null,
    mimeType: String(media.mimeType || '').slice(0, 120) || null,
    processed: Boolean(media.processed),
    processor: ['ocr', 'pdf_text', 'whisper'].includes(media.processor) ? media.processor : null,
    error: String(media.error || '').slice(0, 120) || null,
  };
}

function validTimeZone(value) {
  try { new Intl.DateTimeFormat('en', { timeZone: String(value) }).format(); return true; } catch { return false; }
}

export function eventId() {
  return crypto.randomUUID();
}
