/**
 * WX.MAP Service Worker
 * ─────────────────────
 * Caching strategy:
 *   • Navigation (the HTML document) → NETWORK-FIRST. While online the freshest
 *     index.html is always served, so deploys are picked up on the next reload;
 *     the cached copy is only used as an offline fallback.
 *   • Other same-origin assets (manifest, etc.) → CACHE-FIRST with network fill.
 *   • Cross-origin requests (NOAA API, OSM tiles, Google Fonts, unpkg CDN) are
 *     left untouched and go straight to the network — never cached here.
 *
 * Updates: a new worker installs and waits (it does NOT skipWaiting on its own)
 * so the running session is never disrupted mid-use. The page asks it to activate
 * via a SKIP_WAITING message when the user accepts the update banner.
 *
 * Bump CACHE_NAME whenever the caching logic itself changes so stale caches from
 * older strategies are purged on activate.
 */

const CACHE_NAME = 'wxmap-v3';

/* App-shell URLs precached at install so the app works offline on first launch. */
const SHELL_URLS = [
  './',
  './index.html',
  './manifest.json'
];

/* ── Install: precache the app shell. No skipWaiting — wait for the page's signal. ── */
self.addEventListener('install', event => {
  console.info('[SW] Installing…');
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      // addAll is atomic; fall back to best-effort individual adds so one missing
      // asset can't abort the whole install.
      cache.addAll(SHELL_URLS).catch(() =>
        Promise.all(SHELL_URLS.map(url =>
          cache.add(url).catch(err =>
            console.warn(`[SW] Failed to precache ${url}:`, err.message))
        ))
      )
    ).then(() => console.info('[SW] Install complete (waiting to activate)'))
  );
});

/* ── Activate: drop caches from previous versions, then control existing pages. ── */
self.addEventListener('activate', event => {
  console.info('[SW] Activating…');
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* ── Message handler: the page tells a waiting worker to take over immediately. ── */
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    console.info('[SW] SKIP_WAITING received — activating new version');
    self.skipWaiting();
  }
});

/* ── Fetch routing ── */
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Only manage same-origin traffic; everything cross-origin (API/tiles/CDN/fonts)
  // passes through untouched.
  if (new URL(req.url).origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req));
  } else {
    event.respondWith(cacheFirst(req));
  }
});

/**
 * Network-first: serve fresh from the network and refresh the cache; on failure
 * (offline) fall back to the cached document.
 * @param {Request} req
 * @returns {Promise<Response>}
 */
async function networkFirst(req) {
  try {
    const res = await fetch(req);
    const cache = await caches.open(CACHE_NAME);
    cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const cache = await caches.open(CACHE_NAME);
    return (await cache.match(req)) ||
           (await cache.match('./index.html')) ||
           (await cache.match('./')) ||
           Response.error();
  }
}

/**
 * Cache-first: serve from cache when present, otherwise fetch and cache.
 * @param {Request} req
 * @returns {Promise<Response>}
 */
async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;

  const res = await fetch(req);
  if (res.ok) {
    const cache = await caches.open(CACHE_NAME);
    cache.put(req, res.clone()).catch(() => {});
  }
  return res;
}
