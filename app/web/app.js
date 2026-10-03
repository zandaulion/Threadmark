import { installUpdates } from '/pwa-update.js';
import { parseVCard } from '/vcard.js';

const state = {
  authenticated: false,
  device: null,
  items: [],
  groups: [],
  contacts: [],
  gmailSources: [],
  rules: [],
  summary: { open: 0, payments: 0, meetings: 0, reminders: 0, groups: 0, contacts: 0, gmail: 0 },
  filter: 'all',
  status: 'open',
  scopeMode: 'groups',
  scopeQuery: '',
  bridge: { connection: 'disconnected' },
  gmail: { configured: false, connection: 'not_configured', account: null },
  detection: { enabled: false, provider: 'TypeSafe AI', model: 'jev-latest', threshold: 0.78 },
  settings: { contextAware: false, outgoingMonitoring: false, attachmentProcessing: false, dailyDigest: false, digestTime: '19:00', replyDelayHours: 8 },
  busy: false,
  stream: null,
  streamRetryTimer: null,
};

let foregroundRefreshPromise = null;
let foregroundRefreshStartedAt = 0;
let wasHidden = document.hidden;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const gate = $('#gate');
const app = $('#app');
const feed = $('#feed');

installUpdates({
  appName: 'Threadmark',
  toast: showToast,
  isBusy: () => state.busy || $('#pair-dialog').open || $('#groups-dialog').open || $('#rules-dialog').open || $('#settings-dialog').open,
});

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers },
  });
  let payload = {};
  try { payload = await response.json(); } catch {}
  if (response.status === 401) {
    state.authenticated = false;
    showGate('This device is no longer registered. Enter a new invitation code.');
  }
  if (!response.ok) throw new Error(payload.message || readableError(payload.error) || `Request failed (${response.status})`);
  return payload;
}

async function boot() {
  $('#today-label').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());
  const invite = new URL(location.href).searchParams.get('invite');
  if (invite) $('#invite-code').value = invite;
  try {
    const session = await api('/api/auth/session');
    if (!session.authenticated) return showGate(invite ? 'Invitation ready. Activate this device to continue.' : '');
    state.authenticated = true;
    state.device = session.device;
    showApp();
    await refreshAll();
    finishGmailRedirect();
    await refreshAlertStatus();
    connectStream();
    registerModelTools();
  } catch (error) {
    showGate(error.message);
  }
}

function showGate(message = '') {
  clearTimeout(state.streamRetryTimer);
  state.streamRetryTimer = null;
  state.stream?.close();
  gate.hidden = false;
  app.hidden = true;
  $('#invite-error').textContent = message;
}

function showApp() {
  gate.hidden = true;
  app.hidden = false;
  const clean = new URL(location.href);
  clean.searchParams.delete('invite');
  history.replaceState(null, '', clean.pathname + clean.search + clean.hash);
}

function finishGmailRedirect() {
  const current = new URL(location.href);
  const result = current.searchParams.get('gmail');
  if (!result) return;
  showToast(result === 'connected' ? 'Gmail connected. Choose labels or senders to monitor.' : 'Gmail could not be connected. Check the server and Google OAuth configuration.');
  current.searchParams.delete('gmail');
  current.searchParams.delete('reason');
  history.replaceState(null, '', current.pathname + current.search + current.hash);
}

async function refreshAll() {
  const [summary, feedResult, groups, contacts, gmailSources, rules, bridge, gmail, detection, settings] = await Promise.all([
    api('/api/summary'),
    api(`/api/feed?type=${encodeURIComponent(state.filter)}&status=${encodeURIComponent(state.status)}`),
    api('/api/groups'),
    api('/api/contacts'),
    api('/api/gmail/sources'),
    api('/api/rules'),
    api('/api/whatsapp/status'),
    api('/api/gmail/status'),
    api('/api/detection/status'),
    api('/api/settings'),
  ]);
  state.summary = summary;
  state.items = feedResult.items;
  state.groups = groups.groups;
  state.contacts = contacts.contacts;
  state.gmailSources = gmailSources.sources;
  state.rules = rules.rules;
  state.bridge = bridge;
  state.gmail = gmail;
  state.detection = detection;
  state.settings = settings;
  render();
}

function render() {
  renderSummary();
  renderFeed();
  renderSources();
  renderRules();
  renderBridge();
  renderDetection();
  renderSettings();
}

function renderSummary() {
  $('#summary-open').textContent = state.summary.open;
  $('#summary-payments').textContent = state.summary.payments;
  $('#summary-meetings').textContent = state.summary.meetings;
}

function renderFeed() {
  if (!state.items.length) {
    feed.innerHTML = `<div class="empty-state"><div class="empty-glyph">✓</div><h2>${state.status === 'open' ? 'Nothing waiting' : state.status === 'snoozed' ? 'Nothing snoozed' : 'No completed items'}</h2><p>Items in this view will appear here.</p></div>`;
    return;
  }
  feed.innerHTML = state.items.map((item) => `
    <article class="attention-item" data-item-id="${escapeHtml(item.id)}">
      <div class="item-kind ${item.type}" aria-hidden="true">${item.type === 'payment' ? 'RON' : item.type === 'meeting' ? '◫' : '!'}</div>
      <div>
        <div class="item-topline"><h3>${escapeHtml(item.title)}</h3><span class="item-group">${escapeHtml(item.source?.name || item.group.name)}</span></div>
        <p class="item-text" id="message-${safeDomId(item.id)}">${escapeHtml(item.details?.needsReview ? 'The handwriting could not be read reliably. Review the original photo in WhatsApp.' : item.text)}</p>
        <button class="message-toggle" type="button" data-action="toggle-message" data-id="${escapeHtml(item.id)}" aria-expanded="false" aria-controls="message-${safeDomId(item.id)}">Show full message</button>
        ${safetyNotice(item)}
        <div class="item-meta"><span>${escapeHtml(item.senderName)}</span><span>·</span><time datetime="${escapeHtml(item.sentAt)}">${formatWhen(item.sentAt)}</time>${detectionSourceBadge(item)}${priorityBadge(item)}${dueBadge(item)}${mediaBadge(item)}<span class="confidence">${Math.round(item.confidence * 100)}% match</span></div>
      </div>
      ${itemActions(item)}
    </article>`).join('');
  requestAnimationFrame(handleItemDeepLink);
}

function handleItemDeepLink() {
  const params = new URLSearchParams(location.hash.replace(/^#/u, ''));
  const itemId = params.get('item');
  if (!itemId) return;
  const article = [...feed.querySelectorAll('.attention-item')].find((item) => item.dataset.itemId === itemId);
  if (!article) return;
  if (params.get('actions') === '1') {
    const actions = article.querySelector('.item-actions');
    if (actions) actions.open = true;
  }
  article.classList.add('deep-link-target');
  article.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => article.classList.remove('deep-link-target'), 2400);
  history.replaceState(null, '', `${location.pathname}${location.search}`);
}

function renderSettings() {
  $('#setting-context').checked = Boolean(state.settings.contextAware);
  $('#setting-outgoing').checked = Boolean(state.settings.outgoingMonitoring);
  $('#setting-attachments').checked = Boolean(state.settings.attachmentProcessing);
  $('#setting-digest').checked = Boolean(state.settings.dailyDigest);
  $('#setting-digest-time').value = state.settings.digestTime || '19:00';
  $('#setting-reply-delay').value = String(state.settings.replyDelayHours || 8);
}

function renderRules() {
  $('#rules-list').innerHTML = state.rules.length
    ? state.rules.map((rule) => `<article class="rule-card ${rule.enabled ? '' : 'disabled'}" data-rule-id="${escapeHtml(rule.id)}">
        <div><h3>${escapeHtml(rule.name)}</h3><div class="rule-meta"><span class="rule-chip ${rule.kind === 'semantic' ? 'semantic' : ''}">${rule.kind === 'semantic' ? 'Jev' : 'Local'}</span><span class="rule-chip">${escapeHtml(categoryLabel(rule.category))}</span>${ruleDescription(rule)}<span>·</span><span>${rule.scope === 'all' ? 'All monitored sources' : `${rule.sourceIds.length} selected sources`}</span>${rule.notify ? '<span>· Alerts</span>' : ''}</div></div>
        <div class="rule-actions"><span class="switch"><input type="checkbox" data-rule-enabled="${escapeHtml(rule.id)}" ${rule.enabled ? 'checked' : ''} aria-label="Enable ${escapeHtml(rule.name)}"><span class="switch-ui"></span></span><button class="rule-action" type="button" data-rule-edit="${escapeHtml(rule.id)}">Edit</button><button class="rule-action" type="button" data-rule-delete="${escapeHtml(rule.id)}">Delete</button></div>
      </article>`).join('')
    : '<div class="empty-state compact"><p>No custom rules yet. Built-in invoice, payment, and meeting detection is still active.</p></div>';
}

function renderSources() {
  const selectedGroups = state.groups.filter((group) => group.selected);
  const selectedContacts = state.contacts.filter((contact) => contact.selected);
  const selectedGmail = state.gmailSources.filter((source) => source.selected);
  const selected = [
    ...selectedGroups.map((source) => ({ ...source, kind: 'Group' })),
    ...selectedContacts.map((source) => ({ ...source, kind: 'Person' })),
    ...selectedGmail.map((source) => ({ ...source, kind: source.kind === 'gmail_label' ? 'Gmail label' : 'Gmail sender' })),
  ];
  const groupLabel = `${selectedGroups.length} ${selectedGroups.length === 1 ? 'group' : 'groups'}`;
  const peopleLabel = `${selectedContacts.length} ${selectedContacts.length === 1 ? 'person' : 'people'}`;
  const gmailLabel = `${selectedGmail.length} Gmail`;
  $('#group-count').textContent = `${groupLabel} · ${peopleLabel} · ${gmailLabel}`;
  $('#selected-groups').innerHTML = selected.length
    ? selected.slice(0, 6).map((source) => `<div class="selected-group"><span>${escapeHtml(source.name)}</span><small>${source.kind}</small></div>`).join('')
    : '<p>No sources selected yet.</p>';
  const query = normaliseSearch(state.scopeQuery);
  const visibleGroups = state.groups.filter((group) => matchesSearch(group, query));
  const visibleContacts = state.contacts.filter((contact) => matchesSearch(contact, query));
  const visibleGmailLabels = state.gmailSources.filter((source) => source.kind === 'gmail_label' && matchesSearch(source, query));
  const visibleGmailSenders = state.gmailSources.filter((source) => source.kind === 'gmail_sender' && matchesSearch(source, query));
  $('#groups-list').innerHTML = visibleGroups.length
    ? visibleGroups.map((group) => `<label class="group-row"><span><strong>${escapeHtml(group.name)}</strong><span>${Number(group.participant_count || 0)} participants</span></span><span class="switch"><input type="checkbox" data-group-id="${escapeHtml(group.id)}" ${group.selected ? 'checked' : ''}><span class="switch-ui"></span></span></label>`).join('')
    : `<div class="empty-state compact"><p>${query ? 'No groups match your search.' : 'Groups will appear after WhatsApp connects.'}</p></div>`;
  $('#contacts-list').innerHTML = visibleContacts.length
    ? visibleContacts.map((contact) => `<label class="group-row"><span><strong>${escapeHtml(contact.name)}</strong><span>${escapeHtml(contactNumber(contact.id))}</span></span><span class="switch"><input type="checkbox" data-contact-id="${escapeHtml(contact.id)}" ${contact.selected ? 'checked' : ''}><span class="switch-ui"></span></span></label>`).join('')
    : `<div class="empty-state compact"><p>${query ? 'No people match your search.' : 'People appear when WhatsApp shares chat metadata or when they message you.'}</p></div>`;
  $('#gmail-labels-list').innerHTML = gmailSourceRows(visibleGmailLabels, query, 'Connect Gmail to load mailbox labels.');
  $('#gmail-senders-list').innerHTML = gmailSourceRows(visibleGmailSenders, query, 'Senders appear after new email arrives. Message content is not retained unless the sender is enabled and a detection matches.');
  const digits = state.scopeQuery.replace(/\D/g, '');
  const exactPhone = state.contacts.some((contact) => contact.id.split('@')[0].replace(/\D/g, '') === digits);
  const canLookup = state.scopeMode === 'contacts' && digits.length >= 8 && digits.length <= 15 && !exactPhone;
  const canPickContacts = Boolean(navigator.contacts?.select);
  $('#contact-lookup-button').hidden = !canLookup;
  $('#import-contacts-button').hidden = state.scopeMode !== 'contacts';
  $('#import-contacts-button').textContent = canPickContacts ? 'Import from phone' : 'Import .vcf';
  $('#scope-search').placeholder = state.scopeMode === 'contacts' ? 'Search people or enter a phone number'
    : state.scopeMode.startsWith('gmail_') ? 'Search Gmail sources' : 'Search groups';
  $('#scope-search-note').textContent = state.scopeMode === 'contacts'
    ? canLookup ? `Add +${digits} from WhatsApp. It will remain off until you enable it.` : `${visibleContacts.length} of ${state.contacts.length} people shown. ${canPickContacts ? 'Import selected phone contacts' : 'Import a .vcf contacts file'} or enter a full international number.`
    : state.scopeMode === 'gmail_labels' ? `${visibleGmailLabels.length} of ${state.gmailSources.filter((source) => source.kind === 'gmail_label').length} Gmail labels shown.`
      : state.scopeMode === 'gmail_senders' ? `${visibleGmailSenders.length} of ${state.gmailSources.filter((source) => source.kind === 'gmail_sender').length} Gmail senders shown.`
        : `${visibleGroups.length} of ${state.groups.length} groups shown.`;
}

function gmailSourceRows(sources, query, emptyCopy) {
  return sources.length
    ? sources.map((source) => `<label class="group-row"><span><strong>${escapeHtml(source.name)}</strong><span>${source.kind === 'gmail_label' ? 'Gmail label' : 'Email sender'}</span></span><span class="switch"><input type="checkbox" data-gmail-source-id="${escapeHtml(source.id)}" ${source.selected ? 'checked' : ''}><span class="switch-ui"></span></span></label>`).join('')
    : `<div class="empty-state compact"><p>${query ? 'No Gmail sources match your search.' : emptyCopy}</p></div>`;
}

function renderBridge() {
  const connected = state.bridge.connection === 'connected';
  const gmailConnected = state.gmail.connection === 'connected';
  const pairing = state.bridge.connection === 'pairing';
  const connectedCount = Number(connected) + Number(gmailConnected);
  const label = connectedCount === 2 ? 'WhatsApp + Gmail' : connected ? 'WhatsApp connected' : gmailConnected ? 'Gmail connected' : pairing ? 'Ready to pair' : state.bridge.connection === 'connecting' ? 'Connecting' : 'Sources offline';
  $('#connection-label').textContent = label;
  $('#status-dot').className = `status-dot ${connectedCount ? 'connected' : pairing ? 'pairing' : ''}`;
  $('#mini-state').textContent = connectedCount ? `${connectedCount} live` : pairing ? 'Pairing' : 'Offline';
  $('#whatsapp-dialog-state').textContent = connected ? 'Connected' : pairing ? 'Pairing' : 'Offline';
  $('#bridge-copy').textContent = connected
    ? 'New messages from selected groups and people are being checked in real time.'
    : pairing ? 'Scan the linked-device code to begin monitoring.'
      : 'The bridge is reconnecting or waiting for its first link.';
  $('#gmail-bridge-copy').textContent = gmailConnected
    ? `Gmail connected${state.gmail.account ? ` as ${state.gmail.account}` : ''}; checked every ${state.gmail.pollSeconds || 60} seconds.`
    : state.gmail.configured ? 'Gmail is ready to connect.' : 'Add Google OAuth credentials on the server to enable Gmail.';
  $('#gmail-dialog-state').textContent = gmailConnected ? 'Connected' : state.gmail.connection === 'error' ? 'Needs attention' : state.gmail.configured ? 'Not connected' : 'Not configured';
  $('#gmail-dialog-copy').textContent = gmailConnected
    ? `Connected as ${state.gmail.account}. Only new email from enabled labels or senders is inspected.`
    : state.gmail.configured ? 'Authorize read-only access, then choose labels or senders under Monitored sources.' : 'Google OAuth credentials are not configured on this server yet.';
  $('#gmail-connect-button').hidden = gmailConnected;
  $('#gmail-connect-button').disabled = !state.gmail.configured;
  $('#gmail-disconnect-button').hidden = !gmailConnected;
  $('#pair-button').textContent = 'Manage connections';
  $('#pair-connected').hidden = !connected;
  $('#pair-steps').hidden = connected;
  $('#connected-account').textContent = state.bridge.account ? `Linked as ${state.bridge.account}` : 'Threadmark is receiving new messages.';
  if (pairing) $('#qr-image').src = `/api/whatsapp/qr.svg?t=${Date.now()}`;
}

function renderDetection() {
  const enabled = Boolean(state.detection.enabled);
  $('#jev-state').textContent = enabled ? 'Active' : 'Not configured';
  $('#jev-copy').textContent = enabled
    ? `Local detection runs first. Unmatched selected messages and Gmail meeting candidates are checked by ${state.detection.provider} ${state.detection.model}. Invoice judgments use a ${Math.round((state.detection.invoiceThreshold || .68) * 100)}% threshold.`
    : 'Local detectors and custom rules are active. Add a TypeSafe API key on the server to enable the Jev fallback.';
  $('#jev-test').hidden = !enabled;
  $('#privacy-copy').textContent = enabled
    ? state.settings.contextAware || state.settings.outgoingMonitoring
      ? 'Unselected chats never leave this server. You enabled short-lived context for selected chats; Jev receives text and direction labels, never chat identities.'
      : 'Unselected sources never leave this server. After local checks, unmatched text and Gmail meeting candidates from selected sources are sent to TypeSafe AI; source identities are not sent.'
    : 'Unselected chat content is discarded after local routing. Matching excerpts stay on this server only.';
}

function connectStream() {
  clearTimeout(state.streamRetryTimer);
  state.streamRetryTimer = null;
  state.stream?.close();
  const stream = new EventSource('/api/stream');
  state.stream = stream;
  stream.addEventListener('item', async () => { await refreshFeedAndSummary(); });
  stream.addEventListener('groups', (event) => { state.groups = JSON.parse(event.data); renderSources(); });
  stream.addEventListener('contacts', (event) => { state.contacts = JSON.parse(event.data); renderSources(); });
  stream.addEventListener('gmail-sources', (event) => { state.gmailSources = JSON.parse(event.data); renderSources(); });
  stream.addEventListener('rules', (event) => { state.rules = JSON.parse(event.data); renderRules(); });
  stream.addEventListener('bridge', (event) => { state.bridge = JSON.parse(event.data); renderBridge(); });
  stream.addEventListener('settings', (event) => { state.settings = JSON.parse(event.data); renderSettings(); renderDetection(); });
  stream.onerror = () => {
    if (state.stream !== stream || state.streamRetryTimer) return;
    state.streamRetryTimer = setTimeout(() => {
      state.streamRetryTimer = null;
      if (state.authenticated && !document.hidden) connectStream();
    }, 5000);
  };
}

async function refreshFeedAndSummary() {
  const [summary, result] = await Promise.all([api('/api/summary'), api(`/api/feed?type=${encodeURIComponent(state.filter)}&status=${encodeURIComponent(state.status)}`)]);
  state.summary = summary;
  state.items = result.items;
  renderSummary();
  renderFeed();
}

function refreshOnForeground({ reconnect = false } = {}) {
  if (!state.authenticated || document.hidden) return foregroundRefreshPromise;
  const startedAt = Date.now();
  if (foregroundRefreshPromise || startedAt - foregroundRefreshStartedAt < 750) return foregroundRefreshPromise;
  foregroundRefreshStartedAt = startedAt;
  if (reconnect || !state.stream || state.stream.readyState === EventSource.CLOSED) connectStream();
  foregroundRefreshPromise = refreshFeedAndSummary()
    .catch(() => {})
    .finally(() => { foregroundRefreshPromise = null; });
  return foregroundRefreshPromise;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    wasHidden = true;
    return;
  }
  const reconnect = wasHidden;
  wasHidden = false;
  void refreshOnForeground({ reconnect });
});

window.addEventListener('pageshow', (event) => {
  void refreshOnForeground({ reconnect: event.persisted });
});

window.addEventListener('focus', () => {
  void refreshOnForeground();
});

window.addEventListener('hashchange', () => requestAnimationFrame(handleItemDeepLink));

$('#invite-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  state.busy = true;
  $('#invite-error').textContent = '';
  try {
    const result = await api('/api/auth/redeem', {
      method: 'POST',
      body: JSON.stringify({ code: $('#invite-code').value, label: $('#device-label').value }),
    });
    state.authenticated = true;
    state.device = result.device;
    showApp();
    await refreshAll();
    await refreshAlertStatus();
    connectStream();
  } catch (error) { $('#invite-error').textContent = error.message; }
  finally { state.busy = false; }
});

feed.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  if (button.dataset.action === 'toggle-message') {
    const article = button.closest('.attention-item');
    const expanded = article?.classList.toggle('message-expanded') || false;
    button.textContent = expanded ? 'Collapse message' : 'Show full message';
    button.setAttribute('aria-expanded', String(expanded));
    return;
  }
  button.disabled = true;
  try {
    const id = encodeURIComponent(button.dataset.id);
    if (button.dataset.action === 'done') {
      await api(`/api/items/${id}/status`, { method: 'POST', body: JSON.stringify({ status: 'done' }) });
      showToast('Marked as done');
    } else if (button.dataset.action === 'snooze') {
      const until = new Date(Date.now() + Number(button.dataset.hours || 1) * 3_600_000).toISOString();
      await api(`/api/items/${id}/snooze`, { method: 'POST', body: JSON.stringify({ until }) });
      showToast(`Snoozed for ${button.dataset.hours} hours`);
    } else if (button.dataset.action === 'useful' || button.dataset.action === 'not_relevant') {
      await api(`/api/items/${id}/feedback`, { method: 'POST', body: JSON.stringify({ feedback: button.dataset.action }) });
      showToast(button.dataset.action === 'useful' ? 'Saved as useful feedback' : 'Removed and saved as feedback');
    } else if (button.dataset.action === 'category') {
      await api(`/api/items/${id}/feedback`, { method: 'POST', body: JSON.stringify({ feedback: 'wrong_category', category: button.dataset.category }) });
      showToast(`Moved to ${categoryLabel(button.dataset.category).toLowerCase()}`);
    }
    await refreshFeedAndSummary();
  } catch (error) { showToast(error.message); button.disabled = false; }
});

$$('.tab').forEach((tab) => tab.addEventListener('click', async () => {
  state.filter = tab.dataset.filter;
  $$('.tab').forEach((item) => { item.classList.toggle('active', item === tab); item.setAttribute('aria-selected', String(item === tab)); });
  await refreshFeedAndSummary();
}));

$$('[data-status]').forEach((tab) => tab.addEventListener('click', async () => {
  state.status = tab.dataset.status;
  $$('[data-status]').forEach((item) => {
    item.classList.toggle('active', item === tab);
    item.setAttribute('aria-selected', String(item === tab));
  });
  await refreshFeedAndSummary();
}));

$('#refresh-button').addEventListener('click', refreshAll);
$('#groups-button').addEventListener('click', openSources);
$('#edit-groups-button').addEventListener('click', openSources);
$('#mobile-groups-button').addEventListener('click', openSources);
function openSources() { renderSources(); $('#groups-dialog').showModal(); }

$$('[data-scope-tab]').forEach((tab) => tab.addEventListener('click', () => {
  $$('[data-scope-tab]').forEach((item) => {
    item.classList.toggle('active', item === tab);
    item.setAttribute('aria-selected', String(item === tab));
  });
  $('#groups-list').hidden = tab.dataset.scopeTab !== 'groups';
  $('#contacts-list').hidden = tab.dataset.scopeTab !== 'contacts';
  $('#gmail-labels-list').hidden = tab.dataset.scopeTab !== 'gmail_labels';
  $('#gmail-senders-list').hidden = tab.dataset.scopeTab !== 'gmail_senders';
  state.scopeMode = tab.dataset.scopeTab;
  state.scopeQuery = '';
  $('#scope-search').value = '';
  renderSources();
}));

$('#scope-search').addEventListener('input', (event) => {
  state.scopeQuery = event.target.value;
  renderSources();
});

async function lookupContact() {
  const digits = state.scopeQuery.replace(/\D/g, '');
  if (state.scopeMode !== 'contacts' || digits.length < 8 || digits.length > 15) return;
  const button = $('#contact-lookup-button');
  button.disabled = true;
  try {
    const result = await api('/api/contacts/lookup', { method: 'POST', body: JSON.stringify({ phoneNumber: digits }) });
    state.contacts = (await api('/api/contacts')).contacts;
    renderSources();
    showToast(`${result.contact?.name || `+${digits}`} added. Enable monitoring when ready.`);
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; }
}
$('#contact-lookup-button').addEventListener('click', lookupContact);
$('#scope-search').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  void lookupContact();
});

$('#import-contacts-button').addEventListener('click', async () => {
  if (!navigator.contacts?.select) {
    $('#contacts-file').click();
    return;
  }
  const button = $('#import-contacts-button');
  button.disabled = true;
  try {
    const picked = await navigator.contacts.select(['name', 'tel'], { multiple: true });
    const contacts = [];
    for (const contact of picked || []) {
      const name = Array.isArray(contact.name) ? contact.name[0] : contact.name;
      const phones = Array.isArray(contact.tel) ? contact.tel : [contact.tel];
      for (const phoneNumber of phones) contacts.push({ phoneNumber, name });
    }
    await importContacts(contacts);
  } catch (error) {
    if (error?.name !== 'AbortError') showToast(error.message);
  } finally { button.disabled = false; }
});

$('#contacts-file').addEventListener('change', async (event) => {
  const button = $('#import-contacts-button');
  button.disabled = true;
  try {
    const contacts = [];
    for (const file of event.target.files || []) contacts.push(...parseVCard(await file.text()));
    await importContacts(contacts);
  } catch (error) { showToast(error.message); }
  finally { event.target.value = ''; button.disabled = false; }
});

async function importContacts(records) {
  const byPhone = new Map();
  for (const contact of records) {
    const phoneNumber = String(contact?.phoneNumber || '').replace(/\D/g, '');
    if (phoneNumber.length >= 8 && phoneNumber.length <= 15 && !byPhone.has(phoneNumber)) {
      byPhone.set(phoneNumber, String(contact?.name || '').trim());
    }
  }
  const contacts = [...byPhone].slice(0, 100).map(([phoneNumber, name]) => ({ phoneNumber, name }));
  if (!contacts.length) throw new Error('No usable phone numbers were found.');
  const result = await api('/api/contacts/import', { method: 'POST', body: JSON.stringify({ contacts }) });
  state.contacts = (await api('/api/contacts')).contacts;
  state.scopeQuery = '';
  $('#scope-search').value = '';
  renderSources();
  showToast(`${result.contacts?.length || 0} WhatsApp ${result.contacts?.length === 1 ? 'contact' : 'contacts'} imported. Enable only the people you want monitored.`);
}

$('#groups-list').addEventListener('change', async (event) => {
  const input = event.target.closest('[data-group-id]');
  if (!input) return;
  input.disabled = true;
  try {
    await api(`/api/groups/${encodeURIComponent(input.dataset.groupId)}/selection`, { method: 'POST', body: JSON.stringify({ selected: input.checked }) });
    state.groups = (await api('/api/groups')).groups;
    state.summary = await api('/api/summary');
    renderSources();
    renderSummary();
  } catch (error) { input.checked = !input.checked; showToast(error.message); }
  finally { input.disabled = false; }
});

$('#contacts-list').addEventListener('change', async (event) => {
  const input = event.target.closest('[data-contact-id]');
  if (!input) return;
  input.disabled = true;
  try {
    await api(`/api/contacts/${encodeURIComponent(input.dataset.contactId)}/selection`, { method: 'POST', body: JSON.stringify({ selected: input.checked }) });
    state.contacts = (await api('/api/contacts')).contacts;
    state.summary = await api('/api/summary');
    renderSources();
    renderSummary();
  } catch (error) { input.checked = !input.checked; showToast(error.message); }
  finally { input.disabled = false; }
});

for (const selector of ['#gmail-labels-list', '#gmail-senders-list']) $(selector).addEventListener('change', async (event) => {
  const input = event.target.closest('[data-gmail-source-id]');
  if (!input) return;
  input.disabled = true;
  try {
    await api(`/api/gmail/sources/${encodeURIComponent(input.dataset.gmailSourceId)}/selection`, { method: 'POST', body: JSON.stringify({ selected: input.checked }) });
    state.gmailSources = (await api('/api/gmail/sources')).sources;
    state.summary = await api('/api/summary');
    renderSources();
  } catch (error) { input.checked = !input.checked; showToast(error.message); }
  finally { input.disabled = false; }
});

for (const selector of ['#rules-button', '#side-rules-button', '#mobile-rules-button']) $(selector).addEventListener('click', openRules);
function openRules() {
  renderRules();
  closeRuleForm();
  $('#jev-details').open = false;
  $('#rules-dialog').showModal();
}
$('#rules-close').addEventListener('click', () => $('#rules-dialog').close());
$('#new-rule-button').addEventListener('click', () => openRuleForm());
$('#cancel-rule-button').addEventListener('click', closeRuleForm);

for (const selector of ['#settings-button', '#side-settings-button', '#mobile-settings-button']) $(selector).addEventListener('click', () => {
  renderSettings();
  $('#settings-error').textContent = '';
  $('#settings-dialog').showModal();
});
$('#settings-close').addEventListener('click', () => $('#settings-dialog').close());
$('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  state.busy = true;
  $('#settings-error').textContent = '';
  try {
    state.settings = await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        contextAware: $('#setting-context').checked,
        outgoingMonitoring: $('#setting-outgoing').checked,
        attachmentProcessing: $('#setting-attachments').checked,
        dailyDigest: $('#setting-digest').checked,
        digestTime: $('#setting-digest-time').value,
        replyDelayHours: Number($('#setting-reply-delay').value),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    });
    $('#settings-dialog').close();
    renderDetection();
    showToast('Preferences saved. Bridge changes apply within 15 seconds.');
  } catch (error) { $('#settings-error').textContent = error.message; }
  finally { state.busy = false; }
});

function openRuleForm(rule = null) {
  $('#rule-form').hidden = false;
  $('#new-rule-button').hidden = true;
  $('#rule-form-title').textContent = rule ? 'Edit rule' : 'New rule';
  $('#rule-id').value = rule?.id || '';
  $('#rule-name').value = rule?.name || '';
  $('#rule-kind').value = rule?.kind || 'phrase';
  $('#rule-category').value = rule?.category || 'reminder';
  $('#rule-match-mode').value = rule?.matchMode || 'any';
  $('#rule-terms').value = rule?.terms?.join('\n') || '';
  $('#rule-condition').value = rule?.condition || '';
  $('#rule-threshold').value = Math.round((rule?.threshold || state.detection.threshold || 0.78) * 100);
  $('#rule-scope').value = rule?.scope || 'all';
  $('#rule-notify').checked = rule?.notify !== false;
  $('#rule-test-text').value = '';
  $('#rule-test-result').textContent = '';
  $('#rule-error').textContent = '';
  renderRuleSources(rule?.sourceIds || []);
  $('#rule-sources').hidden = $('#rule-scope').value !== 'sources';
  renderRuleKind();
  $('#rule-name').focus();
}

function closeRuleForm() {
  $('#rule-form').hidden = true;
  $('#new-rule-button').hidden = false;
  $('#rule-error').textContent = '';
  $('#rule-test-result').textContent = '';
}

function renderRuleSources(selectedIds = []) {
  const selected = new Set(selectedIds);
  const sources = [
    ...state.groups.filter((source) => source.selected).map((source) => ({ ...source, kind: 'Group' })),
    ...state.contacts.filter((source) => source.selected).map((source) => ({ ...source, kind: 'Person' })),
    ...state.gmailSources.filter((source) => source.selected).map((source) => ({ ...source, kind: source.kind === 'gmail_label' ? 'Gmail label' : 'Gmail sender' })),
  ];
  $('#rule-sources').innerHTML = sources.length
    ? sources.map((source) => `<label class="rule-source"><input type="checkbox" value="${escapeHtml(source.id)}" ${selected.has(source.id) ? 'checked' : ''}><span>${escapeHtml(source.name)} <small>${source.kind}</small></span></label>`).join('')
    : '<div class="empty-state compact"><p>Select at least one monitored source first.</p></div>';
}

$('#rule-scope').addEventListener('change', () => {
  $('#rule-sources').hidden = $('#rule-scope').value !== 'sources';
});

$('#rule-kind').addEventListener('change', renderRuleKind);

function renderRuleKind() {
  const semantic = $('#rule-kind').value === 'semantic';
  $('#phrase-rule-fields').hidden = semantic;
  $('#semantic-rule-fields').hidden = !semantic;
  $('#rule-terms').required = !semantic;
  $('#rule-condition').required = semantic;
  $('#rule-test-privacy').hidden = !semantic;
  $('#test-rule-button').textContent = semantic ? 'Test with Jev' : 'Test rule';
  $('#rule-test-text').placeholder = semantic
    ? 'Paste a sample message. It will be sent to TypeSafe AI and is not saved.'
    : 'Paste a sample message here. It is tested locally and is not saved.';
  $('#rule-test-result').textContent = '';
}

function rulePayload() {
  const existing = state.rules.find((rule) => rule.id === $('#rule-id').value);
  return {
    name: $('#rule-name').value,
    kind: $('#rule-kind').value,
    category: $('#rule-category').value,
    matchMode: $('#rule-match-mode').value,
    terms: $('#rule-terms').value.split(/\n/u).map((term) => term.trim()).filter(Boolean),
    condition: $('#rule-condition').value,
    threshold: Number($('#rule-threshold').value) / 100,
    scope: $('#rule-scope').value,
    sourceIds: $$('#rule-sources input:checked').map((input) => input.value),
    notify: $('#rule-notify').checked,
    enabled: existing?.enabled ?? true,
  };
}

$('#test-rule-button').addEventListener('click', async () => {
  $('#rule-error').textContent = '';
  $('#rule-test-result').textContent = 'Testing…';
  try {
    const result = await api('/api/rules/test', { method: 'POST', body: JSON.stringify({ rule: rulePayload(), text: $('#rule-test-text').value }) });
    const semantic = $('#rule-kind').value === 'semantic';
    $('#rule-test-result').textContent = semantic
      ? `${result.matched ? 'Matches' : 'Does not match'} · ${Math.round(result.probability * 100)}% / ${Math.round(result.threshold * 100)}%`
      : result.matched ? `Matches (${result.matchedTerms.join(', ')})` : 'Does not match';
    $('#rule-test-result').className = result.matched ? 'matched' : 'not-matched';
  } catch (error) {
    $('#rule-test-result').textContent = '';
    $('#rule-error').textContent = error.message;
  }
});

$('#test-jev-button').addEventListener('click', async () => {
  const text = $('#jev-test-text').value.trim();
  if (!text) return showToast('Enter a sample message first.');
  $('#jev-test-result').textContent = 'Testing…';
  try {
    const result = await api('/api/detection/test', { method: 'POST', body: JSON.stringify({ text }) });
    const scores = [...Object.entries(result.scores || {}).map(([category, score]) => `${categoryLabel(category)} ${Math.round(score * 100)}%`),
      ...Object.entries(result.signals || {}).map(([signal, score]) => `${signal === 'urgency' ? 'Urgency' : signal} ${Math.round(score * 100)}%`)].join(' · ');
    const matched = result.detections?.[0];
    $('#jev-test-result').textContent = matched ? `${categoryLabel(matched.type)} matched · ${scores}` : `No match · ${scores}`;
    state.detection = { ...state.detection, ...result };
    renderDetection();
  } catch (error) {
    $('#jev-test-result').textContent = error.message;
  }
});

$('#rule-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  state.busy = true;
  $('#rule-error').textContent = '';
  try {
    const id = $('#rule-id').value;
    const rule = await api(id ? `/api/rules/${encodeURIComponent(id)}` : '/api/rules', { method: id ? 'PUT' : 'POST', body: JSON.stringify(rulePayload()) });
    state.rules = (await api('/api/rules')).rules;
    renderRules();
    closeRuleForm();
    showToast(`${rule.name} saved`);
  } catch (error) { $('#rule-error').textContent = error.message; }
  finally { state.busy = false; }
});

$('#rules-list').addEventListener('change', async (event) => {
  const input = event.target.closest('[data-rule-enabled]');
  if (!input) return;
  input.disabled = true;
  try {
    await api(`/api/rules/${encodeURIComponent(input.dataset.ruleEnabled)}/enabled`, { method: 'POST', body: JSON.stringify({ enabled: input.checked }) });
    state.rules = (await api('/api/rules')).rules;
    renderRules();
  } catch (error) { input.checked = !input.checked; showToast(error.message); }
});

$('#rules-list').addEventListener('click', async (event) => {
  const edit = event.target.closest('[data-rule-edit]');
  if (edit) {
    const rule = state.rules.find((item) => item.id === edit.dataset.ruleEdit);
    if (rule) openRuleForm(rule);
    return;
  }
  const remove = event.target.closest('[data-rule-delete]');
  if (!remove) return;
  const rule = state.rules.find((item) => item.id === remove.dataset.ruleDelete);
  if (!rule || !confirm(`Delete “${rule.name}”? Existing attention items will remain.`)) return;
  try {
    await api(`/api/rules/${encodeURIComponent(rule.id)}`, { method: 'DELETE' });
    state.rules = (await api('/api/rules')).rules;
    renderRules();
    showToast('Rule deleted');
  } catch (error) { showToast(error.message); }
});

for (const selector of ['#connection-button', '#pair-button', '#mobile-connect-button']) $(selector).addEventListener('click', openPairing);
async function openPairing() {
  $('#pair-dialog').showModal();
  try {
    [state.bridge, state.gmail] = await Promise.all([api('/api/whatsapp/status'), api('/api/gmail/status')]);
    renderBridge();
  }
  catch (error) { showToast(error.message); }
}
$('#pair-close').addEventListener('click', () => $('#pair-dialog').close());

$('#gmail-connect-button').addEventListener('click', async () => {
  const button = $('#gmail-connect-button');
  button.disabled = true;
  try {
    const result = await api('/api/gmail/connect', { method: 'POST', body: '{}' });
    if (!result.authorizationUrl?.startsWith('https://accounts.google.com/')) throw new Error('Google returned an invalid authorization URL.');
    location.assign(result.authorizationUrl);
  } catch (error) { showToast(error.message); button.disabled = false; }
});

$('#gmail-disconnect-button').addEventListener('click', async () => {
  if (!confirm('Disconnect Gmail and remove its OAuth tokens from this server? Existing attention items will remain.')) return;
  try {
    state.gmail = await api('/api/gmail/disconnect', { method: 'POST', body: '{}' });
    renderBridge();
    showToast('Gmail disconnected');
  } catch (error) { showToast(error.message); }
});

$$('[data-pair-tab]').forEach((tab) => tab.addEventListener('click', () => {
  $$('[data-pair-tab]').forEach((item) => item.classList.toggle('active', item === tab));
  $('#pair-qr').hidden = tab.dataset.pairTab !== 'qr';
  $('#pair-phone').hidden = tab.dataset.pairTab !== 'phone';
}));

$('#pair-code-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  state.busy = true;
  $('#pairing-code').textContent = '…';
  try {
    const result = await api('/api/whatsapp/pairing-code', { method: 'POST', body: JSON.stringify({ phoneNumber: $('#phone-number').value }) });
    $('#pairing-code').textContent = String(result.code || '').match(/.{1,4}/g)?.join(' ') || result.code;
  } catch (error) { $('#pairing-code').textContent = error.message; }
  finally { state.busy = false; }
});

$('#alerts-button').addEventListener('click', enableAlerts);
async function enableAlerts() {
  try {
    if (!('Notification' in window) || !('serviceWorker' in navigator)) throw new Error('Notifications are not supported on this device.');
    const key = await api('/api/push/key');
    if (!key.enabled) throw new Error('Push notifications are not configured on the server yet.');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('Notification permission was not granted.');
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription()
      || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64Key(key.publicKey) });
    await api('/api/push/subscription', { method: 'POST', body: JSON.stringify(subscription) });
    setAlertButton('enabled');
    showToast('Private alerts are enabled on this device');
  } catch (error) { showToast(error.message); }
}

async function refreshAlertStatus() {
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    setAlertButton('unavailable');
    return;
  }
  if (Notification.permission === 'denied') {
    setAlertButton('blocked');
    return;
  }
  try {
    const key = await api('/api/push/key');
    if (!key.enabled) {
      setAlertButton('unavailable');
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      setAlertButton('disabled');
      return;
    }
    await api('/api/push/subscription', { method: 'POST', body: JSON.stringify(subscription) });
    setAlertButton('enabled');
  } catch {
    setAlertButton('disabled');
  }
}

function setAlertButton(status) {
  const button = $('#alerts-button');
  const enabled = status === 'enabled';
  button.textContent = enabled ? 'Alerts enabled' : status === 'blocked' ? 'Alerts blocked' : status === 'unavailable' ? 'Alerts unavailable' : 'Enable alerts';
  button.disabled = status === 'blocked' || status === 'unavailable';
  button.classList.toggle('enabled', enabled);
  button.setAttribute('aria-pressed', String(enabled));
}

function registerModelTools() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const register = (tool) => Promise.resolve(context.registerTool(tool)).catch(() => {});
  register({
    name: 'list_attention_items',
    title: 'List attention items',
    description: 'List currently open invoice, payment, meeting, and reminder items detected by Threadmark.',
    inputSchema: { type: 'object', properties: { type: { type: 'string', enum: ['all', 'payment', 'meeting', 'reminder'] } }, additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    async execute(input) {
      const result = await api(`/api/feed?type=${encodeURIComponent(input?.type || 'all')}`);
      return { items: result.items.map(({ id, type, title, source, group, senderName, sentAt, status, detectionSource, priority }) => ({ id, type, title, source: (source || group).name, sourceKind: source?.kind || 'group', senderName, sentAt, status, detectionSource, priority })) };
    },
  });
  register({
    name: 'set_attention_item_status',
    title: 'Update attention item',
    description: 'Mark a Threadmark attention item as done or reopen it.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', enum: ['open', 'done'] } }, required: ['id', 'status'], additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    async execute(input) {
      if (!input?.id || !['open', 'done'].includes(input.status)) throw new Error('A valid item id and status are required.');
      const item = await api(`/api/items/${encodeURIComponent(input.id)}/status`, { method: 'POST', body: JSON.stringify({ status: input.status }) });
      await refreshFeedAndSummary();
      return { id: item.id, status: item.status };
    },
  });
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, 3400);
}

function formatWhen(value) {
  const date = new Date(value);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return new Intl.DateTimeFormat(undefined, sameDay ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function safeDomId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/gu, '-');
}

function normaliseSearch(value) {
  return String(value || '').trim().toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function matchesSearch(source, query) {
  if (!query) return true;
  return normaliseSearch(`${source.name} ${source.id}`).includes(query.replace(/^\+/, ''));
}

function contactNumber(id) {
  if (!String(id).endsWith('@s.whatsapp.net')) return 'Individual chat';
  const digits = String(id).split('@')[0].replace(/\D/g, '');
  return digits ? `+${digits}` : 'Individual chat';
}

function categoryLabel(category) {
  return ({ payment: 'Payment', meeting: 'Meeting', reminder: 'Reminder' })[category] || 'Rule';
}

function ruleDescription(rule) {
  return rule.kind === 'semantic'
    ? `<span>${escapeHtml(rule.condition)}</span><span>· ${Math.round(rule.threshold * 100)}%</span>`
    : `<span>${rule.matchMode === 'all' ? 'All' : 'Any'}: ${escapeHtml(rule.terms.join(', '))}</span>`;
}

function detectionSourceBadge(item) {
  const source = item.details?.verification?.detector === 'jev' ? 'rule-jev'
    : item.detectionSource === 'jev' || item.details?.detector === 'jev' ? 'jev'
    : item.detectionSource === 'review' || item.details?.detector === 'review' ? 'review' : 'rule';
  const label = source === 'rule-jev' ? 'Rule + Jev' : source === 'jev' ? 'Jev' : source === 'review' ? 'Review' : 'Rule';
  const description = source === 'rule-jev' ? 'Detected locally and confirmed by Jev'
    : source === 'jev' ? 'Detected by Jev' : source === 'review' ? 'Image from a monitored contact needs review' : 'Detected by local rules';
  return `<span class="detection-source ${source}" title="${description}" aria-label="${description}">${label}</span>`;
}

function priorityBadge(item) {
  const priority = Number(item.priority);
  return Number.isFinite(priority) && priority >= 0.78
    ? `<span class="priority-chip" title="Jev urgency probability">Urgent ${Math.round(priority * 100)}%</span>`
    : '';
}

function dueBadge(item) {
  if (!item.eventAt) return '';
  const date = new Date(item.eventAt);
  if (Number.isNaN(date.valueOf())) return '';
  const overdue = date < new Date();
  const label = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
  return `<span class="due-chip ${overdue ? 'overdue' : ''}" title="Normalized deadline or event time">${overdue ? 'Due' : 'By'} ${escapeHtml(label)}</span>`;
}

function mediaBadge(item) {
  if (item.details?.needsReview) return '<span class="media-chip review" title="The image was processed locally and is not stored by Threadmark">Image not stored</span>';
  if (!item.media?.processed) return '';
  const label = item.media.processor === 'whisper' ? 'Voice transcribed locally' : item.media.processor === 'pdf_text' ? 'PDF read locally' : 'Image read locally';
  return `<span class="media-chip" title="${escapeHtml(label)}">${escapeHtml(label)}</span>`;
}

function safetyNotice(item) {
  const alerts = Array.isArray(item.details?.safetyAlerts) ? item.details.safetyAlerts : [];
  return alerts.length ? `<div class="safety-notice"><strong>Verify before paying</strong>${alerts.map((alert) => `<span>${escapeHtml(alert)}</span>`).join('')}</div>` : '';
}

function itemActions(item) {
  if (state.status === 'done') return `<button class="done-button" type="button" data-action="useful" data-id="${escapeHtml(item.id)}">Useful</button>`;
  const calendar = item.eventAt ? `<a class="menu-action" href="/api/items/${encodeURIComponent(item.id)}/calendar.ics" download>Add to calendar</a>` : '';
  const contactNumber = item.source?.kind === 'contact' ? String(item.source.id || '').match(/^(\d+)@s\.whatsapp\.net$/u)?.[1] : '';
  const whatsapp = item.details?.needsReview && contactNumber ? `<a class="menu-action" href="https://wa.me/${contactNumber}" target="_blank" rel="noopener">Open WhatsApp chat</a>` : '';
  const gmail = item.source?.kind?.startsWith('gmail_') && item.externalUrl ? `<a class="menu-action" href="${escapeHtml(item.externalUrl)}" target="_blank" rel="noopener">Open in Gmail</a>` : '';
  return `<div class="item-action-strip">
    <button class="quick-done" type="button" data-action="done" data-id="${escapeHtml(item.id)}" aria-label="Mark ${escapeHtml(item.title)} as done" title="Mark done"><span aria-hidden="true">✓</span> Done</button>
    <details class="item-actions"><summary>Actions</summary><div class="item-action-menu">
    ${whatsapp}${gmail}
    <button type="button" data-action="snooze" data-hours="1" data-id="${escapeHtml(item.id)}">Snooze 1 hour</button>
    <button type="button" data-action="snooze" data-hours="24" data-id="${escapeHtml(item.id)}">Snooze 1 day</button>
    ${calendar}<button type="button" data-action="useful" data-id="${escapeHtml(item.id)}">This was useful</button>
    <button type="button" data-action="not_relevant" data-id="${escapeHtml(item.id)}">Not relevant</button>
    <span class="menu-label">Move to</span>${['payment', 'meeting', 'reminder'].filter((category) => category !== item.type).map((category) => `<button type="button" data-action="category" data-category="${category}" data-id="${escapeHtml(item.id)}">${categoryLabel(category)}</button>`).join('')}
  </div></details></div>`;
}

function readableError(code) {
  return ({ invalid_invite: 'That invitation is invalid, expired or already used.', throttled: 'Too many attempts. Try again later.', bridge_unavailable: 'The WhatsApp bridge is not available yet.', contact_not_found: 'That number is not registered on WhatsApp.', contact_lookup_failed: 'WhatsApp could not look up that number.', invalid_phone_number: 'Enter a full phone number including country code.', jev_not_configured: 'Jev is not configured on the server yet.', jev_unavailable: 'Jev is temporarily unavailable. Local detection is still active.' })[code];
}

function base64Key(value) {
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

setInterval(async () => {
  if (!state.authenticated) return;
  try { [state.bridge, state.gmail] = await Promise.all([api('/api/whatsapp/status'), api('/api/gmail/status')]); renderBridge(); } catch {}
}, 10_000);

boot();
