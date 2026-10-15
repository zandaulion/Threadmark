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
  if (!data.itemId || typeof self.registration.getNotifications !== 'function') return showSingle(data, data.tag);
  const tag = `threadmark-alerts-${data.profileId || 'personal'}`;
  const [current] = await self.registration.getNotifications({ tag });
  const previous = Array.isArray(current?.data?.alerts) ? current.data.alerts : [];
  const alert = { itemId: data.itemId, category: data.category, urgent: Boolean(data.urgent), line: data.body };
  const alerts = [...previous.filter((entry) => entry.itemId !== data.itemId), alert].slice(-MAX_TRACKED_ALERTS);
  if (alerts.length === 1) return showSingle(data, tag, alerts);
  const prefix = data.profileId && data.profileId !== 'personal' ? `${data.profileName || data.profileId} · ` : '';
  const urgent = alerts.some((entry) => entry.urgent) ? 'Urgent · ' : '';
  const recent = alerts.slice(-3).reverse().map((entry) => entry.line);
  const more = alerts.length > recent.length ? `\n+${alerts.length - recent.length} more` : '';
  const kinds = breakdown(alerts);
  return self.registration.showNotification(`${prefix}${urgent}${alerts.length} alerts${kinds ? ` · ${kinds}` : ''}`, {
    body: `${recent.join('\n')}${more}`,
    icon: data.icon || '/icons/icon-192.png',
    badge: data.badge || '/icons/icon-192.png',
    tag,
    renotify: true,
    data: { url: data.profileUrl || '/', alerts },
  });
}

function showSingle(data, tag, alerts) {
  return self.registration.showNotification(data.title, {
    body: data.body,
    icon: data.icon || '/icons/icon-192.png',
    badge: data.badge || '/icons/icon-192.png',
    tag,
    ...(alerts ? { renotify: true } : {}),
    actions: Array.isArray(data.actions) ? data.actions.slice(0, 2) : [],
    data: { url: data.url, actionsUrl: data.actionsUrl, itemId: data.itemId, ...(alerts ? { alerts } : {}) },
  });
}

function breakdown(alerts) {
  const counts = {};
  for (const entry of alerts) counts[entry.category] = (counts[entry.category] || 0) + 1;
  return ['payment', 'meeting', 'reminder'].filter((category) => counts[category])
    .map((category) => `${counts[category]} ${CATEGORY_LABELS[category][counts[category] === 1 ? 0 : 1]}`).join(', ');
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const data = event.notification.data || {};
    const fallback = new URL(data.url || '/', self.location.origin).href;
    if (event.action === 'done' && data.itemId) {
      try {
        const response = await fetch(`/api/items/${encodeURIComponent(data.itemId)}/status`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: 'done' }),
        });
        if (response.ok) return;
      } catch {}
      return focusOrOpen(fallback);
    }
    const target = event.action === 'actions'
      ? new URL(data.actionsUrl || data.url || '/', self.location.origin).href
      : fallback;
    return focusOrOpen(target);
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
