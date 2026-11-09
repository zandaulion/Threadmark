const CACHE_NAME = 'threadmark-__BUILD_VERSION__';
const SHELL = ['/', '/index.html', '/app.css', '/app.js', '/vcard.js', '/pwa-update.js', '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/manifest.webmanifest'];
importScripts('/sw-update.js');

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();
    await announceUpdate();
  })());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname === '/bust' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/internal/') || url.searchParams.has('invite')) return;
  event.respondWith((async () => {
    try {
      const response = await fetch(event.request, { cache: 'no-cache' });
      if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone())).catch(() => {});
      return response;
    } catch {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      if (event.request.mode === 'navigate') return (await caches.match('/')) || new Response('Offline', { status: 503 });
      return new Response('Offline', { status: 503 });
    }
  })());
});

// Alerts for a profile share one notification. While it is still on screen,
// each new alert updates it ("3 alerts · 2 payments, 1 action"); once it is
// dismissed or the app is opened, the next alert starts a new one.
const CATEGORY_LABELS = { payment: ['payment', 'payments'], meeting: ['meeting', 'meetings'], reminder: ['action', 'actions'] };
const MAX_TRACKED_ALERTS = 50;
let pushQueue = Promise.resolve();

self.addEventListener('push', (event) => {
  let data = { title: 'Threadmark', body: 'A new item needs your attention.', url: '/', tag: 'threadmark' };
  try { data = { ...data, ...event.data.json() }; } catch {}
  // Pushes are applied one at a time so two quick alerts cannot overwrite each other's update.
  pushQueue = pushQueue.then(() => showPush(data)).catch(() => {});
  event.waitUntil(pushQueue);
});

async function showPush(data) {
  if (data.type === 'dismiss') return dismissAlerts(data);
  if (!data.itemId || typeof self.registration.getNotifications !== 'function') return showSingle(data, data.tag);
  if ((await dismissedIds([data])).includes(data.itemId)) return;
  const tag = `threadmark-alerts-${data.profileId || 'personal'}`;
  const [current] = await self.registration.getNotifications({ tag });
  const previous = Array.isArray(current?.data?.alerts) ? current.data.alerts : [];
  const alert = { ...data, line: data.body };
  const alerts = [...previous.filter((entry) => entry.itemId !== data.itemId), alert].slice(-MAX_TRACKED_ALERTS);
  return renderAlerts(alerts, data);
}

async function dismissedIds(alerts) {
  try {
    const response = await fetch('/api/notifications/state', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alerts: alerts.map(({ itemId, issuedAt }) => ({ itemId, issuedAt })) }),
      signal: globalThis.AbortSignal?.timeout(4000),
    });
    if (!response.ok) return [];
    const payload = await response.json();
    return Array.isArray(payload.dismissedIds) ? payload.dismissedIds : [];
  } catch { return []; }
}

async function dismissAlerts(data) {
  if (!Array.isArray(data.itemIds) || typeof self.registration.getNotifications !== 'function') return;
  const tag = `threadmark-alerts-${data.profileId || 'personal'}`;
  for (const current of await self.registration.getNotifications()) {
    const profileId = current.data?.profileId || (current.tag === tag || current.tag?.startsWith(`${data.profileId || 'personal'}:`)
      ? data.profileId || 'personal' : null);
    if (profileId !== (data.profileId || 'personal')) continue;
    const alerts = Array.isArray(current.data?.alerts) ? current.data.alerts : current.data?.itemId ? [current.data] : [];
    const remaining = alerts.filter((entry) => !data.itemIds.includes(entry.itemId)
      || (data.dismissedAt && entry.issuedAt && entry.issuedAt > data.dismissedAt));
    if (remaining.length === alerts.length) continue;
    if (!remaining.length) current.close();
    else await renderAlerts(remaining, { ...current.data, profileId }, true);
  }
}

async function renderAlerts(alerts, data, quiet = false) {
  const profileId = data.profileId || 'personal';
  const tag = `threadmark-alerts-${profileId}`;
  const metadata = { profileId, profileName: data.profileName, profileUrl: data.profileUrl || data.url || '/' };
  if (alerts.length === 1) {
    const entry = alerts[0];
    return showSingle({ ...metadata, ...entry, title: entry.title || 'Threadmark alert', body: entry.line || entry.body,
      url: entry.url || `${metadata.profileUrl}#item=${encodeURIComponent(entry.itemId)}`,
      actionsUrl: entry.actionsUrl || `${metadata.profileUrl}#item=${encodeURIComponent(entry.itemId)}&actions=1`,
      actions: entry.actions || [{ action: 'done', title: 'Done' }, { action: 'actions', title: 'Actions' }],
    }, tag, alerts, quiet);
  }
  const prefix = profileId !== 'personal' ? `${data.profileName || profileId} · ` : '';
  const urgent = alerts.some((entry) => entry.urgent) ? 'Urgent · ' : '';
  const recent = alerts.slice(-3).reverse().map((entry) => entry.line || entry.body);
  const more = alerts.length > recent.length ? `\n+${alerts.length - recent.length} more` : '';
  const kinds = breakdown(alerts);
  return self.registration.showNotification(`${prefix}${urgent}${alerts.length} alerts${kinds ? ` · ${kinds}` : ''}`, {
    body: `${recent.join('\n')}${more}`,
    icon: data.icon || '/icons/icon-192.png', badge: data.badge || '/icons/icon-192.png', tag,
    ...(quiet ? { silent: true, renotify: false } : { renotify: true }),
    data: { ...metadata, url: metadata.profileUrl, alerts },
  });
}

function showSingle(data, tag, alerts, quiet = false) {
  return self.registration.showNotification(data.title, {
    body: data.body, icon: data.icon || '/icons/icon-192.png', badge: data.badge || '/icons/icon-192.png', tag,
    ...(quiet ? { silent: true, renotify: false } : alerts ? { renotify: true } : {}),
    actions: Array.isArray(data.actions) ? data.actions.slice(0, 2) : [],
    data: { ...data, ...(alerts ? { alerts } : {}) },
  });
}

self.addEventListener('message', (event) => {
  if (event.data?.type === 'notification-capabilities') {
    event.ports?.[0]?.postMessage({ dismiss: true });
    return;
  }
  if (event.data?.type !== 'dismiss') return;
  pushQueue = pushQueue.then(() => dismissAlerts(event.data)).catch(() => {});
  event.waitUntil(pushQueue);
});

function breakdown(alerts) {
  const counts = {};
  for (const entry of alerts) counts[entry.category] = (counts[entry.category] || 0) + 1;
  return ['payment', 'meeting', 'reminder'].filter((category) => counts[category])
    .map((category) => `${counts[category]} ${CATEGORY_LABELS[category][counts[category] === 1 ? 0 : 1]}`).join(', ');
}

self.addEventListener('notificationclick', (event) => {
  const data = event.notification.data || {};
  if (event.action === 'done' && data.itemId) {
    // Keep completion in the worker: no window focus/navigation on success or
    // failure. Android/Chrome still own whether the system shade collapses.
    pushQueue = pushQueue.then(async () => {
      try {
        const response = await fetch(`/api/items/${encodeURIComponent(data.itemId)}/status`, {
          method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: 'done' }),
        });
        if (!response.ok) throw new Error('completion_failed');
        await dismissAlerts({ type: 'dismiss', profileId: data.profileId || 'personal', itemIds: [data.itemId] });
        if (typeof self.registration.getNotifications !== 'function') event.notification.close();
      } catch {
        // Some browsers remove the clicked notification before dispatch. Restore
        // it quietly so a failed request remains actionable without opening the app.
        const current = typeof self.registration.getNotifications === 'function'
          ? await self.registration.getNotifications({ tag: event.notification.tag }) : [];
        if (!current.length) await showSingle({ ...data, title: event.notification.title || 'Threadmark',
          body: 'Could not mark done. Check your connection and try Done again.',
          actions: [{ action: 'done', title: 'Done' }, { action: 'actions', title: 'Actions' }],
        }, event.notification.tag || data.tag, data.alerts, true);
      }
    }).catch(() => {});
    event.waitUntil(pushQueue);
    return;
  }
  event.notification.close();
  event.waitUntil((async () => {
    const target = event.action === 'actions' ? data.actionsUrl || data.url || '/' : data.url || '/';
    return focusOrOpen(new URL(target, self.location.origin).href);
  })());
});

async function focusOrOpen(target) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const existing = windows.find((client) => client.url.startsWith(self.location.origin));
  if (existing) {
    await existing.focus();
    return existing.navigate(target);
  }
  return self.clients.openWindow(target);
}
