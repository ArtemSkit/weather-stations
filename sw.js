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

/*
 * Single source of truth for the app version. It is woven into CACHE_NAME so that
 * bumping it changes THIS FILE'S BYTES — which is exactly what makes the browser
 * detect a new service worker and run the in-app update flow (install → wait →
 * "update available" banner → activate → reload). Without a change here, a deploy
 * that only touches index.html is invisible to an installed standalone PWA until a
 * cold relaunch, so always bump APP_VERSION on release.
 *
 * The page also asks the active worker for this value (GET_VERSION) to show it in
 * the bottom-left version badge, so the badge always reflects the version actually
 * running. Keep APP_VERSION in sync with APP_VERSION_FALLBACK in index.html.
 */
const APP_VERSION = '1.0.0';
const CACHE_NAME  = `wxmap-v${APP_VERSION}`;

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
  const data = event.data;
  if (!data) return;

  // The page tells a waiting worker to take over immediately (user accepted update).
  if (data.type === 'SKIP_WAITING') {
    console.info('[SW] SKIP_WAITING received — activating new version');
    self.skipWaiting();
  }

  // The page asks which version is running so it can show it in the version badge.
  // Reply on the MessageChannel port the page supplied with the request.
  if (data.type === 'GET_VERSION' && event.ports && event.ports[0]) {
    event.ports[0].postMessage(APP_VERSION);
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
