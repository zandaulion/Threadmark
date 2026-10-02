const CATEGORIES = new Set(['payment', 'meeting', 'reminder']);
const MATCH_MODES = new Set(['any', 'all']);
const SCOPES = new Set(['all', 'sources']);
const RULE_KINDS = new Set(['phrase', 'semantic']);

export function normaliseRule(input = {}, existing = {}) {
  const name = String(input.name ?? existing.name ?? '').trim().slice(0, 80);
  if (!name) throw invalid('Rule name is required.');
  const kind = RULE_KINDS.has(input.kind) ? input.kind : RULE_KINDS.has(existing.kind) ? existing.kind : 'phrase';
  const rawTerms = Array.isArray(input.terms) ? input.terms : Array.isArray(existing.terms) ? existing.terms : [];
  const terms = [...new Set(rawTerms.map((term) => String(term).trim()).filter((term) => term.length >= 2).map((term) => term.slice(0, 120)))].slice(0, 30);
  const condition = String(input.condition ?? existing.condition ?? '').trim().slice(0, 500);
  if (kind === 'phrase' && !terms.length) throw invalid('Add at least one phrase with two or more characters.');
  if (kind === 'semantic' && condition.length < 8) throw invalid('Describe what Jev should notice using at least eight characters.');
  const category = CATEGORIES.has(input.category) ? input.category : CATEGORIES.has(existing.category) ? existing.category : 'reminder';
  const matchMode = MATCH_MODES.has(input.matchMode) ? input.matchMode : MATCH_MODES.has(existing.matchMode) ? existing.matchMode : 'any';
  const scope = SCOPES.has(input.scope) ? input.scope : SCOPES.has(existing.scope) ? existing.scope : 'all';
  const rawSources = Array.isArray(input.sourceIds) ? input.sourceIds : Array.isArray(existing.sourceIds) ? existing.sourceIds : [];
  const sourceIds = [...new Set(rawSources.map((id) => String(id).slice(0, 200)).filter(Boolean))].slice(0, 200);
  if (scope === 'sources' && !sourceIds.length) throw invalid('Choose at least one monitored chat.');
  return {
    name,
    kind,
    terms: kind === 'phrase' ? terms : [],
    condition: kind === 'semantic' ? condition : '',
    threshold: boundedNumber(input.threshold ?? existing.threshold, 0.78, 0.5, 0.99),
    category,
    matchMode: kind === 'phrase' ? matchMode : 'any',
    scope,
    sourceIds: scope === 'sources' ? sourceIds : [],
    notify: input.notify === undefined ? existing.notify !== false : Boolean(input.notify),
    enabled: input.enabled === undefined ? existing.enabled !== false : Boolean(input.enabled),
  };
}

export function testRule(rule, text) {
  const haystack = normaliseText(text);
  const matchedTerms = rule.terms.filter((term) => haystack.includes(normaliseText(term)));
  const matched = rule.matchMode === 'all' ? matchedTerms.length === rule.terms.length : matchedTerms.length > 0;
  return { matched, matchedTerms };
}

export function evaluateRules(message, source, rules) {
  const detections = [];
  for (const rule of rules) {
    if (!rule.enabled || rule.kind === 'semantic') continue;
    if (rule.scope === 'sources' && !rule.sourceIds.includes(source.id)) continue;
    const result = testRule(rule, message.text);
    if (!result.matched) continue;
    detections.push({
      type: rule.category,
      key: `rule-${rule.id}`,
      title: rule.name,
      confidence: rule.matchMode === 'all' ? 0.95 : 0.84,
      amountMinor: null,
      currency: null,
      eventAt: null,
      notify: rule.notify,
      details: { ruleId: rule.id, matchedTerms: result.matchedTerms },
    });
  }
  return detections;
}

function normaliseText(value) {
  return String(value || '').toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/gu, '');
}

function invalid(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function boundedNumber(value, fallback, minimum, maximum) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= minimum && numeric <= maximum ? numeric : fallback;
}
