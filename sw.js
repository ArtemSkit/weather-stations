/**
 * WX.MAP Service Worker
 * ─────────────────────
 * Caching strategy:
 *   • Navigation (the HTML document) → APP-SHELL CACHE. HTML and its vendored
 *     runtime change together only after the user accepts an installed update.
 *   • Declared same-origin shell assets → CACHE-FIRST.
 *   • Other same-origin traffic → pass-through, so future private/dynamic data is
 *     never persisted accidentally.
 *   • Cross-origin requests (NOAA API, OSM tiles, Google Fonts) are
 *     left untouched and go straight to the network — never cached here.
 *
 * Updates: a new worker installs and waits (it does NOT skipWaiting on its own)
 * so the running session is never disrupted mid-use. The page asks it to activate
 * via a SKIP_WAITING message when the user accepts the update banner.
 *
 * Bump APP_VERSION whenever the caching logic or shell changes so stale caches from
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
const APP_VERSION = '1.0.8';
const CACHE_NAME = `wxmap-weather-stations-v${APP_VERSION}`;
// The legacy alternative is retained only so this release can clean up caches
// created before the more ownership-specific name was introduced.
const OWNED_CACHE_PATTERN = /^(?:wxmap-v|wxmap-weather-stations-v)\d+\.\d+\.\d+$/;

/* App-shell URLs precached at install so the app works offline on first launch. */
const SHELL_URLS = [
  './index.html',
  './manifest.json',
  './leaflet.css',
  './leaflet.js',
  './LEAFLET-LICENSE.txt',
  './images/layers.png',
  './images/layers-2x.png',
  './images/marker-icon.png'
];
// Updating sw.js bypasses its own HTTP cache, but not the fetches made by addAll.
// Reload requests ensure a newly versioned worker installs one coherent release.
const SHELL_REQUESTS = SHELL_URLS.map(url =>
  new Request(new URL(url, self.location.href).href, { cache: 'reload' })
);
const SHELL_ASSET_URLS = new Set(
  SHELL_URLS.slice(1).map(url => new URL(url, self.location.href).href)
);

/* ── Install: precache the app shell. No skipWaiting — wait for the page's signal. ── */
self.addEventListener('install', event => {
  console.info('[SW] Installing…');
  event.waitUntil(
    // All shell files are required. If any is unavailable, installation fails and
    // the last known-good worker/cache continues serving the application.
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_REQUESTS))
      .then(() => console.info('[SW] Install complete (waiting to activate)'))
  );
});

/* ── Activate: drop caches from previous versions, then control existing pages. ── */
self.addEventListener('activate', event => {
  console.info('[SW] Activating…');
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        // CacheStorage is shared by an origin. Match the complete WX.MAP naming
        // convention so a similarly prefixed application cannot be deleted.
        keys.filter(k => OWNED_CACHE_PATTERN.test(k) && k !== CACHE_NAME)
            .map(k => caches.delete(k))
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
  const requestUrl = new URL(req.url);
  if (requestUrl.origin !== self.location.origin) return;

  // Exact shell assets take precedence over the navigation fallback. Browsers use
  // navigation mode when a user opens the license link, and that request must
  // return the notice itself rather than the HTML app shell.
  if (SHELL_ASSET_URLS.has(requestUrl.href)) {
    event.respondWith(cacheFirst(req));
  } else if (req.mode === 'navigate') {
    event.respondWith(serveAppShell(req));
  }
});

/**
 * Serve the HTML from the same atomically installed cache as its runtime assets.
 * The network fallback is only for abnormal cache eviction; normal releases swap
 * the complete shell through the waiting-worker update flow.
 * @param {Request} req
 * @returns {Promise<Response>}
 */
async function serveAppShell(req) {
  const cache = await caches.open(CACHE_NAME);
  return (await cache.match('./index.html')) || fetch(req);
}

/**
 * Cache-first: serve from cache when present, otherwise fetch and cache.
 * @param {Request} req
 * @returns {Promise<Response>}
 */
async function cacheFirst(req) {
  // Match only this app's cache; a same-origin app may cache the same request URL.
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  if (cached) return cached;

  const res = await fetch(req);
  // Only allowlisted public shell assets reach this function.
  if (res.ok) await cache.put(req, res.clone()).catch(() => {});
  return res;
}
