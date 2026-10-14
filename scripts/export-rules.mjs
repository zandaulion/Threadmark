// Exports rule definitions in a form that is safe to share or commit: only the
// fields below are written, never source IDs, timestamps or anything else
// stored next to them. Rules limited to specific chats are refused, because
// their scope is made of phone numbers, group IDs and email addresses.
//
// Usage: node scripts/export-rules.mjs [--skip-scoped] [--out rules.json] [path/to/threadmark.sqlite]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// Text that looks like a phone number, email address or WhatsApp/Gmail source ID.
const IDENTIFYING = [
  { label: 'phone number', pattern: /\+?\d[\d\s().-]{6,}\d/u },
  { label: 'email address', pattern: /[^\s@]+@[^\s@]+\.[^\s@]+/u },
  { label: 'WhatsApp or Gmail ID', pattern: /@(?:s\.whatsapp\.net|g\.us|lid)\b|gmail:(?:label|sender):/u },
];

export function exportRules(db, { skipScoped = false } = {}) {
  const rules = [];
  const problems = [];
  for (const row of db.prepare('SELECT * FROM rules ORDER BY profile_id, kind, name').all()) {
    if (row.scope !== 'all') {
      if (!skipScoped) problems.push(`"${row.name}" is limited to specific sources; rerun with --skip-scoped to leave it out`);
      continue;
    }
    const rule = {
      name: row.name,
      profile: row.profile_id,
      kind: row.kind,
      category: row.category,
      ...(row.kind === 'semantic'
        ? { condition: row.semantic_condition, threshold: row.threshold }
        : { terms: JSON.parse(row.terms_json || '[]'), matchMode: row.match_mode }),
      notify: Boolean(row.notify),
      enabled: Boolean(row.enabled),
    };
    const text = [rule.name, rule.condition, ...(rule.terms || [])].filter(Boolean).join('\n');
    const found = IDENTIFYING.filter(({ pattern }) => pattern.test(text)).map(({ label }) => label);
    if (found.length) {
      problems.push(`"${row.name}" contains what looks like a ${found.join(' and ')}`);
      continue;
    }
    rules.push(rule);
  }
  return { rules, problems };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const skipScoped = args.includes('--skip-scoped');
  const outIndex = args.indexOf('--out');
  const out = outIndex >= 0 ? args[outIndex + 1] : '';
  const positional = args.filter((arg, index) => !arg.startsWith('--') && (outIndex < 0 || index !== outIndex + 1));
  const database = positional[0] || path.join(process.env.THREADMARK_DATA_DIR || path.join(os.homedir(), '.local/share/threadmark/app'), 'threadmark.sqlite');
  if (!fs.existsSync(database)) {
    console.error(`${database} does not exist.`);
    process.exit(2);
  }
  const db = new DatabaseSync(database, { readOnly: true });
  const { rules, problems } = exportRules(db, { skipScoped });
  db.close();
  if (problems.length) {
    console.error(`Nothing was exported:\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  const json = `${JSON.stringify({ format: 'threadmark-rules-v1', rules }, null, 2)}\n`;
  if (out) {
    fs.writeFileSync(out, json, { flag: 'wx' });
    console.error(`Wrote ${rules.length} rules to ${out}.`);
  } else {
    process.stdout.write(json);
  }
}
