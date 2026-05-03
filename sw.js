/* Chogi PWA Service Worker
   Strategy: network-first for HTML (always try fresh, fall back to cache),
             cache-first for static assets (icons, video, json).
   Versioned cache → bumping CHOGI_VERSION invalidates everything cleanly. */

const CHOGI_VERSION   = 'v1.0.0-2026-05-03';
const CACHE_RUNTIME   = 'chogi-runtime-' + CHOGI_VERSION;
const CACHE_PRECACHE  = 'chogi-shell-'   + CHOGI_VERSION;

/* shell-level files we want available offline immediately */
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/lab.html',
  '/cto.html',
  '/burn.html',
  '/family.html',
  '/badge.html',
  '/slots.html',
  '/promo.html',
  '/manifest.json',
  '/chogi.png',
  '/chogi.jpg',
  '/chog.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/js/burn-meter.js'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_PRECACHE).then((cache) => {
      // Use individual adds so one 404 doesn't break the whole install
      return Promise.allSettled(PRECACHE_URLS.map((url) => cache.add(url)));
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_RUNTIME && k !== CACHE_PRECACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  /* skip cross-origin (DexScreener API, fonts, RPC, X share, etc.) — let them go straight through */
  if (url.origin !== self.location.origin) return;

  /* skip RPC / API endpoints — must always be fresh */
  if (url.pathname.startsWith('/api/')) return;

  /* HTML navigation: network-first */
  if (req.mode === 'navigate' || req.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_RUNTIME).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('/index.html')))
    );
    return;
  }

  /* static assets: cache-first with background revalidation */
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchAndUpdate = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_RUNTIME).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetchAndUpdate;
    })
  );
});

/* allow page to trigger an update check */
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
