/* Chogi PWA service worker · KILL-SWITCH BUILD
   Version: kill-2026-05-08

   Purpose:
     The previous service worker (chogi-runtime / chogi-shell v2.0.0)
     pre-cached HTML and JS, which left existing visitors stuck on
     stale builds (especially js/payroll.js and admin.html). This
     replacement self-destructs: it activates immediately, deletes
     EVERY cache, unregisters itself, and refreshes any open tabs
     once so they pick up fresh assets from the network.

   After this build has been live for a release cycle, swap it for a
   real PWA worker AT A NEW PATH (e.g. /sw-v3.js) and update the
   registration in js/pwa.js accordingly. Do not reuse /sw.js for a
   real worker after this — some browsers will keep the kill-switch
   semantics tied to that scope until users hard-refresh. */

self.addEventListener('install', () => {
  // Take over from the old SW as fast as possible.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // 1. Wipe every cache this origin owns (chogi-runtime-*, chogi-shell-*, anything else).
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k).catch(() => {})));
    } catch (e) { /* swallow */ }

    // 2. Unregister this service worker so the next page load has no SW at all.
    try { await self.registration.unregister(); } catch (e) { /* swallow */ }

    // 3. Force any currently-open tabs to reload once so they pick up fresh JS/HTML.
    try {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of clients) {
        try { c.navigate(c.url); } catch (e) { /* some browsers disallow */ }
      }
    } catch (e) { /* swallow */ }
  })());
});

/* All fetches go straight to the network. Nothing is served from cache. */
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request).catch(() => new Response('', { status: 504, statusText: 'kill-switch offline' }))
  );
});

/* Ignore any messages from old page code (e.g. SKIP_WAITING from previous pwa.js). */
self.addEventListener('message', () => {});
