/**
 * Service worker for instant repeat visits + basic offline resilience.
 *
 * Strategy is deliberately conservative so a bad cache can never pin a stale or
 * broken site:
 *   - The app shell (/ and /index.html): network-FIRST, falling back to the
 *     cached shell only when offline. New deploys therefore always win on a
 *     live connection. Other pages (/hire.html, /privacy.html, the /z/<zone>
 *     share stubs, the 404 page) are left to the network: caching every
 *     navigation under the shell key could serve one of them as the island.
 *   - This build's hashed files (BUILD_ASSETS): cache-first. Their names are
 *     content hashes, so a cached copy is never stale.
 *   - Models and everything else under /assets/ (public files whose names never
 *     change, and older builds' chunks): network-FIRST, with the cache only as
 *     the offline fallback, so a re-exported model ships on the next visit.
 *   - Everything else (Firebase RTDB, analytics, /api, cross-origin): passed
 *     straight through, never intercepted.
 *
 * BUILD_ID and BUILD_ASSETS are stamped into dist/sw.js by the sw-build-stamp
 * plugin in vite.config.ts. A fresh BUILD_ID makes every deploy's worker
 * byte-different, so the browser installs it and activate runs once per
 * deploy. (The old worker never changed, so its activate-time flush ran once
 * and never again.) The values below are what `vite dev` serves; dev never
 * registers the worker.
 *
 * skipWaiting + clients.claim means a new worker takes over immediately, so an
 * update is at most one reload away. To kill the SW entirely, ship a worker
 * whose activate handler calls self.registration.unregister().
 */
const BUILD_ID = 'dev';
const BUILD_ASSETS = [];
const CACHE = `island-${BUILD_ID}`;
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/favicon.svg'];
const HASHED = new Set(BUILD_ASSETS);
const isModel = (pathname) => pathname.startsWith('/assets/models/');

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

// Runs once per deploy. Every cache except this build's is deleted, but this
// build's own hashed files and the models are carried over first: the visit
// that installs this worker is served by the previous one, which caches the
// new build's chunks under its own (old) cache name.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      for (const name of await caches.keys()) {
        if (name === CACHE) continue;
        try {
          const old = await caches.open(name);
          for (const req of await old.keys()) {
            const { pathname } = new URL(req.url);
            if (!HASHED.has(pathname) && !isModel(pathname)) continue;
            if (await cache.match(req)) continue;
            const res = await old.match(req);
            if (res) await cache.put(req, res);
          }
        } catch {
          /* an unreadable old cache must not block activation */
        }
        await caches.delete(name).catch(() => false);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Only handle our own origin; let Firebase / analytics / fonts go to network.
  if (url.origin !== self.location.origin) return;

  // App shell: network-first so a live connection always gets the newest HTML.
  // Only a good shell response may become the offline fallback.
  if (req.mode === 'navigate') {
    if (url.pathname !== '/' && url.pathname !== '/index.html') return;
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches
              .open(CACHE)
              .then((c) => c.put('/index.html', copy))
              .catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match('/index.html').then((m) => m || caches.match('/'))),
    );
    return;
  }

  if (!url.pathname.startsWith('/assets/')) return;

  // This build's content-hashed files: cache-first, nothing to revalidate.
  if (HASHED.has(url.pathname)) {
    event.respondWith(
      caches.open(CACHE).then((cache) =>
        cache.match(req).then(
          (hit) =>
            hit ||
            fetch(req).then((res) => {
              if (res.ok) cache.put(req, res.clone()).catch(() => {});
              return res;
            }),
        ),
      ),
    );
    return;
  }

  // Models and every other file under /assets/: network-first, cache fallback.
  event.respondWith(
    caches.open(CACHE).then((cache) =>
      fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone()).catch(() => {});
          return res;
        })
        .catch(() => cache.match(req).then((hit) => hit || Response.error())),
    ),
  );
});
