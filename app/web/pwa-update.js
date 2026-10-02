const RELOADED_KEY = 'pwa-kit:updated';

function defaultToast(message) {
  const element = document.createElement('div');
  element.setAttribute('role', 'status');
  element.textContent = message;
  Object.assign(element.style, {
    position: 'fixed', top: 'max(14px, calc(env(safe-area-inset-top) + 10px))', left: '50%',
    transform: 'translateX(-50%)', background: '#111827', color: '#f7f3ea', padding: '11px 18px',
    borderRadius: '99px', font: '500 15px/1.3 system-ui, sans-serif', boxShadow: '0 6px 24px rgba(0,0,0,.28)',
    maxWidth: '90vw', textAlign: 'center', zIndex: '2147483647'
  });
  document.body.appendChild(element);
  setTimeout(() => element.remove(), 3200);
}

export function installUpdates({ appName = 'The app', message = null, toast = defaultToast, isBusy = () => false, scriptUrl = '/sw.js' } = {}) {
  if (!('serviceWorker' in navigator)) return;
  if (sessionStorage.getItem(RELOADED_KEY)) {
    sessionStorage.removeItem(RELOADED_KEY);
    toast(message || `${appName} updated to the latest version`);
  }
  const start = async () => {
    let registration;
    try { registration = await navigator.serviceWorker.register(scriptUrl, { updateViaCache: 'none' }); }
    catch (error) { console.warn('service worker did not register:', error); return; }
    registration.update().catch(() => {});
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') registration.update().catch(() => {});
    });
    const periodic = setInterval(() => {
      if (document.visibilityState === 'visible') registration.update().catch(() => {});
    }, 60_000);
    window.addEventListener('pagehide', () => clearInterval(periodic), { once: true });
    let reloading = false;
    const reload = () => {
      if (reloading) return;
      reloading = true;
      sessionStorage.setItem(RELOADED_KEY, '1');
      location.reload();
    };
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type !== 'sw-updated') return;
      event.source?.postMessage?.({ type: 'sw-update-ack' });
      navigator.serviceWorker.controller?.postMessage({ type: 'sw-update-ack' });
      if (!isBusy()) return reload();
      const settle = setInterval(() => { if (!isBusy()) { clearInterval(settle); reload(); } }, 2000);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') { clearInterval(settle); reload(); }
      }, { once: true });
    });
  };
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}
