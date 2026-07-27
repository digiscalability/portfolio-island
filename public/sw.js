/**
 * Service worker for instant repeat visits + basic offline resilience.
 *
 * Strategy is deliberately conservative so a bad cache can never pin a stale or
 * broken site:
 *   - Navigations (HTML): network-FIRST, fall back to cached shell only when
 *     offline. New deploys therefore always win on a live connection.
 *   - Hashed build assets (/assets/*): cache-first — the filenames are
 *     content-hashed and immutable, so this is safe and makes repeat loads
 *     instant. Revalidated in the background (stale-while-revalidate).
 *   - Everything else (Firebase RTDB, analytics, cross-origin): passed straight
 *     through, never intercepted.
 *
 * skipWaiting + clients.claim means a new worker takes over immediately, so an
 * update is at most one reload away. To kill the SW entirely, ship a worker
 * whose activate handler calls self.registration.unregister().
 */
const CACHE = 'island-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/favicon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Only handle our own origin; let Firebase / analytics / fonts go to network.
  if (url.origin !== self.location.origin) return;

  // Navigations: network-first so a live connection always gets the newest HTML.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('/index.html').then((m) => m || caches.match('/'))),
    );
    return;
  }

  // Hashed, immutable build assets: cache-first + background revalidate.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.open(CACHE).then((cache) =>
        cache.match(req).then((hit) => {
          const network = fetch(req)
            .then((res) => {
              if (res && res.status === 200) cache.put(req, res.clone());
              return res;
            })
            .catch(() => hit);
          return hit || network;
        }),
      ),
    );
  }
});
