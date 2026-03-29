/**
 * WX.MAP Service Worker
 * Implements cache-first strategy with network fallback
 * Caches app shell and static assets, but not API/CDN responses
 */

const CACHE_NAME = 'wxmap-v2';
const SHELL_URLS = [
  './',
  './manifest.json'
];

/* ── Install: cache the app shell and manifest ── */
self.addEventListener('install', event => {
  console.info('[SW] Installing service worker...');
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // Cache shell URLs and wait for completion
      return Promise.all(SHELL_URLS.map(url =>
        cache.add(url).catch(err => {
          console.warn(`[SW] Failed to cache ${url}:`, err.message);
        })
      ));
    }).then(() => {
      console.info('[SW] Installation complete');
      self.skipWaiting();
    })
  );
});

/* ── Activate: remove outdated caches and claim clients ── */
self.addEventListener('activate', event => {
  console.info('[SW] Activating service worker...');
  event.waitUntil(
    caches.keys().then(keys => {
      const oldCacheNames = keys.filter(k => k !== CACHE_NAME);
      if (oldCacheNames.length > 0) {
        console.info(`[SW] Removing ${oldCacheNames.length} old cache(s)...`);
      }
      return Promise.all(oldCacheNames.map(k => caches.delete(k)));
    }).then(() => {
      console.info('[SW] Activation complete');
      return self.clients.claim();
    })
  );
});

/* ── Fetch: cache-first with network fallback ── */
self.addEventListener('fetch', event => {
  // Only intercept GET requests
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) {
        console.debug('[SW] Cache hit:', event.request.url);
        return cached;
      }

      return fetch(event.request).then(response => {
        // Cache a fresh copy for non-API, non-tile, non-CDN requests
        if (
          response.ok &&
          !event.request.url.includes('api.weather.gov') &&
          !event.request.url.includes('tile.openstreetmap') &&
          !event.request.url.includes('fonts.googleapis') &&
          !event.request.url.includes('fonts.gstatic') &&
          !event.request.url.includes('unpkg.com')
        ) {
          caches.open(CACHE_NAME).then(cache =>
            cache.put(event.request, response.clone()).catch(err => {
              console.warn('[SW] Failed to cache response:', err.message);
            })
          );
        }
        return response;
      }).catch(err => {
        // Network failed — return cached or offline fallback
        console.warn('[SW] Network fetch failed:', event.request.url, err.message);
        return caches.match(event.request);
      });
    })
  );
});
