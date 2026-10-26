const PHASE = { queued: 0, transcribing: 1, ready: 2, failed: 2 };
const ERRORS = new Set(['local_processing_failed', 'no_text_found', 'attachment_too_large', 'audio_too_long',
  'queue_full', 'expired', 'disabled', 'source_unselected', 'interrupted', 'transcript_too_long']);

export function ensureVoiceSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS voice_notes (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    sender_name TEXT NOT NULL, sent_at TEXT NOT NULL, duration_seconds INTEGER,
    status TEXT NOT NULL CHECK(status IN ('queued','transcribing','ready','failed')),
    attempt INTEGER NOT NULL, phase INTEGER NOT NULL, transcript TEXT NOT NULL DEFAULT '',
    error TEXT, retry_until TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS voice_sent_idx ON voice_notes(sent_at DESC);`);
}

export class VoiceStore {
  constructor(db, store) { this.db = db; this.store = store; }

  record(input) {
    const selection = this.store.isSelectedMessage(input);
    if (!selection.selected || selection.profileId !== 'personal' || !['group', 'contact'].includes(selection.source?.kind)
      || !this.store.settings().voiceTranscription || input.direction !== 'incoming') return null;
    const id = String(input.id || '');
    const attempt = Number(input.attempt);
    if (!id || id.length > 160 || !Object.hasOwn(PHASE, input.status) || !Number.isInteger(attempt) || attempt < 1 || attempt > 3) return null;
    const existing = this.get(id);
    if (existing && (existing.source.id !== selection.source.id || attempt < existing.attempt
      || (attempt === existing.attempt && PHASE[input.status] <= PHASE[existing.status])
      || existing.status === 'ready')) return null;
    const transcript = input.status === 'ready' ? String(input.transcript || '').trim() : '';
    if (transcript.length > 64_000) return null;
    if (input.status === 'ready' && !transcript) return null;
    const timestamp = new Date().toISOString();
    const sentAt = new Date(input.sentAt);
    if (!Number.isFinite(sentAt.valueOf())) return null;
    const duration = Number(input.durationSeconds);
    const retryUntil = new Date(input.retryUntil);
    const retry = input.retryUntil && Number.isFinite(retryUntil.valueOf())
      ? new Date(Math.min(retryUntil.valueOf(), Date.now() + 86_400_000)).toISOString() : null;
    this.db.prepare(`INSERT INTO voice_notes
      (id, source_id, sender_name, sent_at, duration_seconds, status, attempt, phase, transcript, error, retry_until, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, attempt=excluded.attempt, phase=excluded.phase,
        transcript=excluded.transcript, error=excluded.error, retry_until=excluded.retry_until, updated_at=excluded.updated_at`)
      .run(id, selection.source.id, String(input.senderName || 'Unknown sender').slice(0, 240), sentAt.toISOString(),
        Number.isFinite(duration) && duration > 0 ? Math.min(Math.round(duration), 86_400) : null,
        input.status, attempt, PHASE[input.status], transcript, ERRORS.has(input.error) ? input.error : null,
        retry, timestamp, timestamp);
    return this.get(id);
  }

  get(id, profile = 'personal') {
    if (profile !== 'personal') return null;
    const row = this.db.prepare(`SELECT v.*, g.name AS source_name, g.kind AS source_kind, g.selected
      FROM voice_notes v JOIN groups g ON g.id=v.source_id WHERE v.id=? AND g.profile_id='personal'`).get(id);
    if (!row) return null;
    return { id: row.id, senderName: row.sender_name, sentAt: row.sent_at, durationSeconds: row.duration_seconds,
      status: row.status, attempt: row.attempt, transcript: row.transcript, error: row.error, updatedAt: row.updated_at,
      retryUntil: row.retry_until,
      retryable: row.status === 'failed' && row.attempt < 3 && Boolean(row.selected)
        && this.store.settings().voiceTranscription && Boolean(row.retry_until && row.retry_until > new Date().toISOString()),
      source: { id: row.source_id, name: row.source_name, kind: row.source_kind }, profile: { id: 'personal' } };
  }

  list(profile = 'personal', before = null) {
    if (profile !== 'personal') return [];
    return this.db.prepare(`SELECT id FROM voice_notes WHERE (? IS NULL OR sent_at<?)
      ORDER BY sent_at DESC, id DESC LIMIT 200`).all(before, before).map((row) => this.get(row.id)).filter(Boolean);
  }

  cancelInactive() {
    return this.db.prepare(`UPDATE voice_notes SET status='failed', phase=2, error=?, retry_until=NULL, updated_at=?
      WHERE status!='ready' AND (?=0 OR source_id IN (SELECT id FROM groups WHERE selected=0))`)
      .run(this.store.settings().voiceTranscription ? 'source_unselected' : 'disabled', new Date().toISOString(),
        this.store.settings().voiceTranscription ? 1 : 0).changes;
  }
}
