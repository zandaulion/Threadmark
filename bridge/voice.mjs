// Retain references/keys for encrypted WhatsApp media here; never audio files.
const DAY = 86_400_000;
export class VoiceJobs {
  constructor(outbox, { now = () => Date.now(), maxPending = 50 } = {}) {
    this.outbox = outbox;
    this.db = outbox.db;
    this.now = now;
    this.maxPending = maxPending;
    this.db.exec(`CREATE TABLE IF NOT EXISTS voice_jobs (
      id TEXT PRIMARY KEY, message_json TEXT NOT NULL, envelope TEXT,
      status TEXT NOT NULL, attempt INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      error TEXT, created_at INTEGER NOT NULL
    );`);
    // Resume interrupted work as a new attempt, so both the retry bound and UI
    // ordering survive restarts. No recording is downloaded more than three times.
    for (const row of this.db.prepare("SELECT * FROM voice_jobs WHERE status='transcribing'").all()) {
      this.transaction(() => {
        this.db.prepare('UPDATE voice_jobs SET status=?, attempt=?, error=?, envelope=? WHERE id=?')
          .run(row.attempt < 3 ? 'queued' : 'failed', Math.min(row.attempt + 1, 3),
            row.attempt < 3 ? null : 'interrupted', row.attempt < 3 ? row.envelope : null, row.id);
        this.emit(this.get(row.id));
      });
    }
  }

  get(id) { return this.db.prepare('SELECT * FROM voice_jobs WHERE id=?').get(id); }
  next() { return this.db.prepare("SELECT * FROM voice_jobs WHERE status='queued' ORDER BY created_at, id LIMIT 1").get(); }
  event(row, extra = {}) {
    return { ...JSON.parse(row.message_json), status: row.status, attempt: row.attempt, error: row.error,
      retryUntil: row.envelope && row.attempt < 3 ? new Date(row.expires_at).toISOString() : null, ...extra };
  }
  emit(row, extra) {
    this.outbox.put(`voice:${row.id}:${row.attempt}:${row.status}`, '/internal/voice-notes', this.event(row, extra));
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  enqueue(message, envelope) {
    if (this.get(message.id)) return false;
    this.expire();
    const count = this.db.prepare("SELECT count(*) AS n FROM voice_jobs WHERE status IN ('queued','transcribing')").get().n;
    const error = count >= this.maxPending ? 'queue_full' : message.durationSeconds > 600 ? 'audio_too_long'
      : envelope.length > 350_000 ? 'attachment_too_large' : null;
    this.transaction(() => {
      this.db.prepare(`INSERT INTO voice_jobs VALUES (?, ?, ?, ?, 1, ?, ?, ?)`)
        .run(message.id, JSON.stringify(message), error ? null : envelope, error ? 'failed' : 'queued', this.now() + DAY, error, this.now());
      this.emit(this.get(message.id));
    });
    return true;
  }

  start(row) {
    return this.transaction(() => {
      const changed = this.db.prepare("UPDATE voice_jobs SET status='transcribing' WHERE id=? AND attempt=? AND status='queued'").run(row.id, row.attempt).changes;
      if (changed) this.emit(this.get(row.id));
      return Boolean(changed);
    });
  }

  finish(row, result, actions = false) {
    return this.transaction(() => {
      const current = this.get(row.id);
      if (!current || current.attempt !== row.attempt || current.status !== 'transcribing') return false;
      const ready = Boolean(result.processed && result.extractedText);
      const permanent = ['attachment_too_large', 'audio_too_long', 'transcript_too_long', 'expired', 'disabled', 'source_unselected'].includes(result.error);
      this.db.prepare('UPDATE voice_jobs SET status=?, error=?, envelope=? WHERE id=?')
        .run(ready ? 'ready' : 'failed', ready ? null : result.error || 'local_processing_failed', ready || permanent || current.attempt >= 3 ? null : current.envelope, row.id);
      const transcript = ready ? String(result.extractedText).slice(0, 64_000) : '';
      this.emit(this.get(row.id), { transcript });
      if (ready && actions) {
        const message = JSON.parse(row.message_json);
        this.outbox.put(`message:${row.id}`, '/internal/events', { ...message, text: transcript.slice(0, 12_000), voiceAttempt: row.attempt,
          origin: 'voice_transcript', media: { kind: 'audio', processed: true, processor: 'whisper' } });
      }
      return true;
    });
  }

  retry(id) {
    this.expire();
    const row = this.get(id);
    if (!row || row.status !== 'failed' || !row.envelope || row.attempt >= 3 || row.expires_at <= this.now()) return null;
    return this.transaction(() => {
      this.db.prepare("UPDATE voice_jobs SET status='queued', error=NULL, attempt=attempt+1 WHERE id=?").run(id);
      this.emit(this.get(id));
      return this.event(this.get(id));
    });
  }

  reconcile(routing) {
    for (const row of this.db.prepare("SELECT * FROM voice_jobs WHERE envelope IS NOT NULL").all()) {
      const sourceId = JSON.parse(row.message_json).sourceId;
      if (routing.voiceTranscription && routing.sourceIds.has(sourceId)) continue;
      this.transaction(() => {
        this.db.prepare("UPDATE voice_jobs SET status='failed', error=?, envelope=NULL WHERE id=?")
          .run(routing.voiceTranscription ? 'source_unselected' : 'disabled', row.id);
        this.emit(this.get(row.id));
      });
    }
  }

  expire() {
    return this.transaction(() => {
      for (const row of this.db.prepare("SELECT * FROM voice_jobs WHERE expires_at<=? AND status IN ('queued','transcribing')").all(this.now())) {
        this.db.prepare("UPDATE voice_jobs SET status='failed', envelope=NULL, error='expired' WHERE id=?").run(row.id);
        this.emit(this.get(row.id));
      }
      this.db.prepare("DELETE FROM voice_jobs WHERE expires_at<=? AND status IN ('ready','failed')").run(this.now());
    });
  }
}

export class VoiceWorker {
  constructor(jobs, { getRouting, transcribe, onUpdate = () => {} }) {
    Object.assign(this, { jobs, getRouting, transcribe, onUpdate });
    this.running = null;
    this.active = null;
    this.closed = false;
  }
  reconcile(routing) {
    this.jobs.reconcile(routing);
    if (this.active && (!routing.voiceTranscription || !routing.sourceIds.has(this.active.sourceId))) this.active.controller.abort();
    this.onUpdate();
  }
  kick() {
    if (this.closed || this.running) return this.running;
    this.running = this.run().catch(() => {}).finally(() => { this.running = null; });
    return this.running;
  }
  async run() {
    while (!this.closed) {
      this.jobs.expire();
      const row = this.jobs.next();
      if (!row) break;
      const routing = await this.getRouting();
      if (this.closed) break;
      if (!routing) break; // Offline: retain the job, without downloading anything.
      this.reconcile(routing);
      if (row.expires_at <= this.jobs.now()) continue;
      if (!this.jobs.start(row)) continue;
      const message = JSON.parse(row.message_json);
      const controller = new AbortController();
      const expiry = setTimeout(() => controller.abort(), Math.max(0, row.expires_at - this.jobs.now()));
      expiry.unref();
      this.active = { sourceId: message.sourceId, controller };
      this.onUpdate();
      let result;
      try { result = await this.transcribe(row.envelope, controller.signal); }
      catch { result = { error: 'local_processing_failed' }; }
      finally { clearTimeout(expiry); }
      this.active = null;
      if (this.closed) break; // Restart resumes the persisted job.
      const currentRouting = await this.getRouting();
      if (currentRouting) this.reconcile(currentRouting);
      if (this.jobs.now() >= row.expires_at) result = { error: 'expired' };
      else if (!currentRouting) result = { error: 'interrupted' };
      this.jobs.finish(row, result || {}, Boolean(currentRouting?.voiceActionDetection));
      this.onUpdate();
    }
  }
  async close() {
    this.closed = true;
    this.active?.controller.abort();
    await this.running;
  }
}
