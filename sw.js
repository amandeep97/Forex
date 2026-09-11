const CACHE = 'forex-pro-v2';
const PRECACHE = ['/Forex/', '/Forex/index.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network first, cache as the fallback — and never hand back `undefined`.
//
// `caches.match()` resolves to undefined on a miss, and respondWith(undefined)
// rejects, which surfaces to the page as a failed request with no useful error.
// For a lazily imported tab chunk that meant the import failed, React's lazy()
// threw, and with nothing catching it the whole app unmounted to a black
// screen. The page could not tell "you are offline" from "the app is broken".
//
// Successful GETs are also stored now. The old version cached only the shell,
// so the fallback had nothing to fall back TO for any chunk — going offline and
// opening a tab you had used a minute earlier still failed.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      // Only cache what actually succeeded. Storing a 404 would serve that 404
      // back forever, which is worse than the miss it replaces.
      if (res && res.ok && (res.type === 'basic' || res.type === 'default')) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      const hit = await caches.match(req);
      if (hit) return hit;
      // An honest error beats undefined: the page gets a response object it can
      // reason about instead of a rejected fetch with no explanation.
      return new Response('offline and not cached', {
        status: 504, statusText: 'offline', headers: { 'Content-Type': 'text/plain' },
      });
    }
  })());
});

self.addEventListener('push', e => {
  if (!e.data) return;
  const { title, body } = e.data.json();
  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/Forex/forex-icon.svg',
      badge: '/Forex/forex-icon.svg',
      vibrate: [200, 100, 200],
      tag: 'forex-signal',
      renotify: true,
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow('/Forex/'));
});
