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

self.addEventListener('push', (event) => {
  let data = { title: 'Threadmark', body: 'A new item needs your attention.', url: '/', tag: 'threadmark' };
  try { data = { ...data, ...event.data.json() }; } catch {}
  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: data.icon || '/icons/icon-192.png',
    badge: data.badge || '/icons/icon-192.png',
    tag: data.tag,
    data: { url: data.url },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((client) => client.url.startsWith(self.location.origin));
    if (existing) { await existing.focus(); return existing.navigate(target); }
    return self.clients.openWindow(target);
  })());
});
