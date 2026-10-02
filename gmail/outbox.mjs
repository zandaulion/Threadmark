import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class Outbox {
  constructor(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(dataDir, 'outbox.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        endpoint TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0
      );`);
  }

  put(id, endpoint, payload) {
    this.db.prepare(`INSERT INTO outbox (id, endpoint, payload_json, created_at, attempts)
      VALUES (?, ?, ?, ?, 0)
      ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json, created_at=excluded.created_at`)
      .run(id, endpoint, JSON.stringify(payload), new Date().toISOString());
  }

  pending(limit = 100) {
    return this.db.prepare('SELECT id, endpoint, payload_json, attempts FROM outbox ORDER BY created_at LIMIT ?').all(limit)
      .map((row) => ({ ...row, payload: JSON.parse(row.payload_json) }));
  }

  delivered(id) { this.db.prepare('DELETE FROM outbox WHERE id=?').run(id); }
  failed(id) { this.db.prepare('UPDATE outbox SET attempts=attempts+1 WHERE id=?').run(id); }
  close() { this.db.close(); }
}
