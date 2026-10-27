/* Service worker for the profile PWA.
 *
 * Scope is limited to /profile.html on purpose (see the register() call in
 * js/pwa.js): only that page is ever served from the cache, so a stale worker
 * can never serve an old board.html / the-meadow.html / admin.html.
 *
 * Caching strategy
 *   navigation to /profile.html  -> network first, cached shell as the offline fallback
 *   /assets/* (hashed bundles)   -> stale-while-revalidate
 *   everything else              -> not handled here (plain network)
 *
 * Updates: this file is rewritten on every build (scripts/stamp-sw.mjs stamps
 * BUILD), so a deploy changes its bytes, the browser installs the new worker in
 * the background and the page shows "New version available". The worker never
 * calls skipWaiting() on its own; the member taps Update, the page posts
 * SKIP_WAITING, the worker takes over and the page reloads once.
 */
const BUILD = '__BUILD__';
const CACHE = 'meadow-profile-' + BUILD;
const CACHE_PREFIX = 'meadow-profile-';
const SHELL = [
  '/profile.html',
  '/manifest.webmanifest',
  '/newlogo.webp',
  '/style.css',
  '/profile-meadow.css',
  '/meadow-theme.css',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map((url) =>
      cache.add(new Request(url, { cache: 'reload' })).catch(() => {})
    ));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE)
        .map((key) => caches.delete(key))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // Supabase, fonts, Stripe CDN
  if (url.pathname === '/sw.js') return;             // never serve the worker from cache

  if (req.mode === 'navigate') {
    const isProfile = url.pathname === '/profile.html' || url.pathname === '/';
    if (!isProfile) return;                          // out-of-scope pages: untouched
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put('/profile.html', fresh.clone()).catch(() => {});
        return fresh;
      } catch (err) {
        const cached = await caches.match('/profile.html');
        return cached || Response.error();
      }
    })());
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      const network = fetch(req)
        .then(async (res) => {
          if (res && res.ok) {
            const cache = await caches.open(CACHE);
            cache.put(req, res.clone()).catch(() => {});
          }
          return res;
        })
        .catch(() => null);
      return cached || (await network) || Response.error();
    })());
  }
});
