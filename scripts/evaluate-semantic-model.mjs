// Runs only the authored synthetic corpus; never opens Threadmark's database or environment file.
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { JevDetector } from '../app/server/jev.mjs';
import { cases } from '../examples/semantic-eval.mjs';

process.env.TZ = 'Europe/Bucharest'; // Match the corpus's expected due dates on every host.

const { values } = parseArgs({ options: {
  export: { type: 'string' }, responses: { type: 'string' }, out: { type: 'string' },
  'base-url': { type: 'string' }, model: { type: 'string', default: 'local-eval' },
  'timeout-ms': { type: 'string', default: '120000' },
  ids: { type: 'string' },
} });
if ([values.export, values.responses, values['base-url']].filter(Boolean).length !== 1) {
  throw new Error('Choose exactly one: --export REQUESTS.jsonl, --responses RESULTS.jsonl, or --base-url URL');
}
const referenceAt = '2026-10-17T09:00:00.000Z';
const requestedIds = values.ids?.split(',');
if (requestedIds?.some((id) => !cases.some((sample) => sample.id === id))) throw new Error('Unknown --ids entry');
const selectedCases = requestedIds ? cases.filter((sample) => requestedIds.includes(sample.id)) : cases;
const rows = [];
for (const sample of selectedCases) {
  let request;
  const detector = new JevDetector({ jevEnabled: true, jevModel: values.model }, {
    async systemOne(value) { request = value; return { answers: {} }; },
  });
  await detector.evaluate(sample.text, sample.monitors, { ...sample.options, referenceAt });
  rows.push({ id: sample.id, language: sample.language, request });
}
if (values.export) {
  await writeFile(values.export, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  console.log(`Exported ${rows.length} synthetic requests.`);
} else {
  const imported = values.responses
    ? (await readFile(values.responses, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : null;
  const byId = new Map();
  for (const row of imported || []) {
    if (byId.has(row.id)) throw new Error(`Duplicate response: ${row.id}`);
    if (!selectedCases.some((sample) => sample.id === row.id)) throw new Error(`Unknown or unselected response: ${row.id}`);
    byId.set(row.id, row);
  }
  const records = [];
  for (const [index, sample] of selectedCases.entries()) {
    let row = byId.get(sample.id);
    if (!imported) {
      const start = performance.now();
      try {
        const url = new URL('/v1/systemone', values['base-url']);
        const response = await fetch(url, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(rows[index].request), signal: AbortSignal.timeout(Number(values['timeout-ms'])),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        row = { id: sample.id, response: await response.json(), latencyMs: performance.now() - start };
      } catch (error) { row = { id: sample.id, error: error.name }; }
    }
    if (!row) row = { id: sample.id, error: 'missing_response' };
    const response = row.response;
    const judgments = Object.entries(sample.labels).map(([key, expected]) => {
      const probability = response?.answers?.[key]?.noul;
      const valid = typeof probability === 'number' && Number.isFinite(probability) && probability >= 0 && probability <= 1;
      const threshold = key === 'invoice' ? 0.68 : key === 'actionable_date' ? 0.8
        : ['payment', 'meeting', 'reminder'].includes(key) || key.startsWith('monitor_') ? 0.78 : null;
      return { key, expected, probability: valid ? probability : null, threshold,
        correct: valid && (probability >= 0.5) === expected,
        thresholdCorrect: threshold === null ? null : valid && (probability >= threshold) === expected,
        brier: valid ? (probability - Number(expected)) ** 2 : null };
    });
    const choices = Object.entries(sample.choices || {}).map(([key, expected]) => ({
      key, expected, actual: response?.answers?.[key]?.choice ?? null,
      correct: response?.answers?.[key]?.choice === expected,
    }));
    // Replay the genuine detector so invoice/monitor precedence and date gates stay in application code.
    const detector = new JevDetector({ jevEnabled: true, jevModel: values.model }, {
      async systemOne() { if (!response || row.error) throw new Error('missing_response'); return response; },
    });
    const result = await detector.evaluate(sample.text, sample.monitors, { ...sample.options, referenceAt });
    const actual = result.detections[0]?.type ?? null;
    const hasDueAt = Object.hasOwn(sample, 'dueAt');
    records.push({ id: sample.id, language: sample.language, error: row.error ?? null,
      latencyMs: row.latencyMs ?? null, withinProductionTimeout: Number.isFinite(row.latencyMs) ? row.latencyMs <= 4500 : null,
      judgments, choices, detection: { expected: sample.detection, actual, correct: result.available && actual === sample.detection },
      ...(hasDueAt ? { date: { expected: sample.dueAt, actual: result.date?.dueAt ?? null,
        correct: result.available && (result.date?.dueAt ?? null) === sample.dueAt } } : {}),
      usage: response?.usage ?? null, metadata: row.metadata ?? null, response: response ?? null });
  }
  const summarize = (records) => {
    const judgments = records.flatMap((row) => row.judgments);
    const valid = judgments.filter((row) => row.brier !== null);
    const choices = records.flatMap((row) => row.choices);
    const dates = records.filter((row) => row.date);
    const times = records.map((row) => row.latencyMs).filter(Number.isFinite).sort((a, b) => a - b);
    return { cases: records.length, errors: records.filter((row) => row.error).length,
      labeledNouls: judgments.length, missingNouls: judgments.length - valid.length,
      correctAtHalf: judgments.filter((row) => row.correct).length,
      labeledDetectionGates: judgments.filter((row) => row.threshold !== null).length,
      correctAtDetectionGate: judgments.filter((row) => row.thresholdCorrect === true).length,
      brier: valid.length ? valid.reduce((sum, row) => sum + row.brier, 0) / valid.length : null,
      choices: choices.length, correctChoices: choices.filter((row) => row.correct).length,
      correctDetections: records.filter((row) => row.detection.correct).length,
      dateCases: dates.length, correctDates: dates.filter((row) => row.date.correct).length,
      timedRequests: times.length,
      p50Ms: times.length ? times[Math.ceil(times.length * 0.5) - 1] : null,
      p95Ms: times.length ? times[Math.ceil(times.length * 0.95) - 1] : null,
      overProductionTimeout: times.filter((time) => time > 4500).length };
  };
  const report = { model: values.model, timezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
    scope: 'Synthetic screening only; no live Jev baseline, threshold fitting, or full ingestion/promotional-routing evaluation.',
    latencyScope: imported ? 'Imported native runtime measurement; see row metadata.' : 'Sequential warm HTTP including queueing.',
    summary: summarize(records), byLanguage: Object.fromEntries(['ro', 'en'].map((language) => [language, summarize(records.filter((r) => r.language === language))])), records };
  if (values.out) await writeFile(values.out, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ model: report.model, summary: report.summary, byLanguage: report.byLanguage }, null, 2));
}
