import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, ThreadmarkStore } from '../app/server/store.mjs';
import { exportRules } from '../scripts/export-rules.mjs';

function storeWithRules(t, rules) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadmark-export-'));
  const db = openDatabase(dataDir);
  t.after(() => { db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const store = new ThreadmarkStore(db);
  store.upsertContacts([{ id: '15550100001@s.whatsapp.net', name: 'Demo Contact' }]);
  store.selectContact('15550100001@s.whatsapp.net', true);
  for (const rule of rules) store.createRule(rule);
  return db;
}

test('exports only rule definitions, never source IDs', (t) => {
  const db = storeWithRules(t, [
    { name: 'School admin', kind: 'semantic', condition: 'A school form or deadline needs action.', category: 'reminder', threshold: 0.8, scope: 'all', notify: true },
    { name: 'Permission form', terms: ['formular', 'semnați'], category: 'reminder', scope: 'all', notify: false },
  ]);
  const { rules, problems } = exportRules(db);
  assert.deepEqual(problems, []);
  // A new database also holds the default Dev monitors; check the ones created here.
  const created = rules.filter((rule) => ['School admin', 'Permission form'].includes(rule.name));
  assert.deepEqual(created.map((rule) => Object.keys(rule).sort()), [
    ['category', 'enabled', 'kind', 'matchMode', 'name', 'notify', 'profile', 'terms'],
    ['category', 'condition', 'enabled', 'kind', 'name', 'notify', 'profile', 'threshold'],
  ]);
});

test('refuses chat-specific rules and identifying text', (t) => {
  const db = storeWithRules(t, [
    { name: 'From Demo', terms: ['plata'], category: 'payment', scope: 'sources', sourceIds: ['15550100001@s.whatsapp.net'] },
    { name: 'Call me', terms: ['+40 712 345 678'], category: 'reminder', scope: 'all' },
    { name: 'Mail', kind: 'semantic', condition: 'Anything from someone@example.com about invoices.', category: 'payment', scope: 'all' },
    { name: 'Safe', terms: ['ședință'], category: 'meeting', scope: 'all' },
  ]);
  const strict = exportRules(db);
  assert.equal(strict.problems.length, 3);
  assert.match(strict.problems.join('\n'), /specific sources/u);
  assert.match(strict.problems.join('\n'), /phone number/u);
  assert.match(strict.problems.join('\n'), /email address/u);
  const skipped = exportRules(db, { skipScoped: true });
  assert.equal(skipped.problems.length, 2, 'skipping scoped rules does not hide identifying text');
  assert.ok(skipped.rules.some((rule) => rule.name === 'Safe'));
  assert.ok(!skipped.rules.some((rule) => ['From Demo', 'Call me', 'Mail'].includes(rule.name)));
  assert.ok(!JSON.stringify(skipped.rules).includes('whatsapp.net'));
});
