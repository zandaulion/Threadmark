import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { evaluateRules, normaliseRule, testRule } from '../app/server/rules.mjs';
import { openDatabase, ThreadmarkStore } from '../app/server/store.mjs';

test('phrase rules match case and Romanian diacritics', () => {
  const rule = { id: 'rule-1', ...normaliseRule({ name: 'School form', terms: ['formular', 'până vineri'], matchMode: 'all', category: 'reminder' }) };
  assert.deepEqual(testRule(rule, 'FORMULARUL trebuie trimis pana vineri.'), {
    matched: true,
    matchedTerms: ['formular', 'până vineri'],
  });
});

test('rule scope and notification preference are preserved in detections', () => {
  const rule = { id: 'rule-2', ...normaliseRule({
    name: 'Trip update', terms: ['excursie'], scope: 'sources', sourceIds: ['parents@g.us'], notify: false,
  }) };
  assert.equal(evaluateRules({ text: 'Detalii despre excursie' }, { id: 'other@g.us' }, [rule]).length, 0);
  const detections = evaluateRules({ text: 'Detalii despre excursie' }, { id: 'parents@g.us' }, [rule]);
  assert.equal(detections.length, 1);
  assert.equal(detections[0].type, 'reminder');
  assert.equal(detections[0].notify, false);
});

test('semantic monitors have a condition and are skipped by local phrase matching', () => {
  const rule = { id: 'semantic-1', ...normaliseRule({
    name: 'Decision needed', kind: 'semantic', condition: 'Someone needs a decision from me.',
    category: 'reminder', threshold: 0.82,
  }) };
  assert.equal(rule.kind, 'semantic');
  assert.equal(rule.threshold, 0.82);
  assert.deepEqual(rule.terms, []);
  assert.deepEqual(evaluateRules({ text: 'Which option should we choose?' }, { id: 'parents@g.us' }, [rule]), []);
});

test('existing phrase rules migrate without changing behavior', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadmark-rules-migration-'));
  try {
    const legacy = new DatabaseSync(path.join(dataDir, 'threadmark.sqlite'));
    legacy.exec(`CREATE TABLE rules (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, terms_json TEXT NOT NULL,
      category TEXT NOT NULL, match_mode TEXT NOT NULL, scope TEXT NOT NULL,
      source_ids_json TEXT NOT NULL, notify INTEGER NOT NULL, enabled INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    legacy.prepare(`INSERT INTO rules VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'legacy', 'School form', '["formular"]', 'reminder', 'any', 'all', '[]', 1, 1,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
    );
    legacy.close();
    const db = openDatabase(dataDir);
    const [rule] = new ThreadmarkStore(db).listRules();
    assert.equal(rule.kind, 'phrase');
    assert.equal(rule.threshold, 0.78);
    assert.deepEqual(rule.terms, ['formular']);
    db.close();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
