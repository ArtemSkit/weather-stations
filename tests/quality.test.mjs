import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const [
  html,
  serviceWorker,
  manifestText,
  leafletCss,
  leafletJs,
  leafletMap,
  leafletLicense,
  layersImage,
  layersRetinaImage,
  markerImage
] = await Promise.all([
  readFile(new URL('index.html', root), 'utf8'),
  readFile(new URL('sw.js', root), 'utf8'),
  readFile(new URL('manifest.json', root), 'utf8'),
  readFile(new URL('leaflet.css', root)),
  readFile(new URL('leaflet.js', root), 'utf8'),
  readFile(new URL('leaflet.js.map', root), 'utf8'),
  readFile(new URL('LEAFLET-LICENSE.txt', root), 'utf8'),
  readFile(new URL('images/layers.png', root)),
  readFile(new URL('images/layers-2x.png', root)),
  readFile(new URL('images/marker-icon.png', root))
]);
const manifest = JSON.parse(manifestText);
const leafletSourceMap = JSON.parse(leafletMap);

/** Extract one named function while ignoring braces inside strings and comments. */
function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} should exist`);
  // Find the brace after the parameter list, not a brace in a default such as
  // `options = {}`; every source function uses the `) {` house style.
  const bodyMarker = html.indexOf(') {', start);
  assert.notEqual(bodyMarker, -1, `function ${name} should have a body`);
  const bodyStart = bodyMarker + 2;
  const body = html.slice(bodyStart);
  const tokens = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\/)|[{}]/g;
  let depth = 0;

  for (const token of body.matchAll(tokens)) {
    if (token[1]) continue;
    if (token[0] === '{') depth++;
    if (token[0] === '}' && --depth === 0) {
      return html.slice(start, bodyStart + token.index + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

/** Load the service worker into a small event-driven harness for routing tests. */
function loadServiceWorker({ cachesImpl, fetchImpl = async () => ({ ok: true, clone() {} }) }) {
  const listeners = new Map();
  const self = {
    location: { href: 'https://example.test/weather/sw.js', origin: 'https://example.test' },
    clients: { claim: async () => {} },
    skipWaiting: async () => {},
    addEventListener(type, handler) { listeners.set(type, handler); }
  };
  class RequestStub {
    constructor(input, options = {}) {
      this.url = new URL(input, self.location.href).href;
      this.cache = options.cache;
    }
  }
  vm.runInNewContext(serviceWorker, {
    self,
    caches: cachesImpl,
    fetch: fetchImpl,
    Request: RequestStub,
    Response,
    URL,
    Set,
    console: { info() {}, warn() {} }
  });
  return listeners;
}

test('inline scripts compile and document IDs remain unique', () => {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1]);
  assert.equal(scripts.length, 3);
  scripts.forEach(script => new Function(script));

  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'duplicate HTML IDs break label and event targeting');
  const idSet = new Set(ids);
  for (const [, references] of html.matchAll(/\saria-(?:labelledby|describedby)="([^"]+)"/g)) {
    for (const id of references.split(/\s+/)) assert.ok(idSet.has(id), `missing ARIA target #${id}`);
  }
  // Every element the scripts look up must exist, or a handler silently never binds.
  for (const [, id] of html.matchAll(/getElementById\('([^']+)'\)/g)) {
    assert.ok(idSet.has(id), `script looks up missing element #${id}`);
  }
});

test('a failed newer search keeps the area that is loading or shown', async () => {
  const log = [];
  let resolveFetch, rejectFetch;
  const h = new Function('fetchStations', 'log', `
    let searchGeneration = 0, areaGeneration = 0, stationOpenGeneration = 0;
    let settledSearch = 0, areaLoading = null;
    let refreshTimer = null, activeStationId = null, activeMarkerEl = null;
    let stationMarkers = [];
    const popupPanel = { style: {} };
    const overlayText = {};
    const map = { getContainer: () => ({ classList: { add() {}, remove() {} } }), getZoom: () => 4 };
    function clearAlerts() {}
    function clearStations() { stationMarkers = []; }
    function moveMapTo() {}
    function plotStations() { stationMarkers = [1, 2]; log.push('plotted'); }
    function setStatus(state, text) { log.push('status:' + state + ':' + text); }
    function showOverlay(m) { log.push('overlay:' + m); }
    function hideOverlay() { log.push('overlay hidden'); }
    function showToast(m) { log.push('toast:' + m); }
    function loadAlertsForArea() { log.push('alerts'); }
    function setForecastPoint() { log.push('forecast point'); }
    function clearForecastPoint() { log.push('forecast cleared'); }
    function clearAlertFocus() {}
    function liveSearchLanded() {}
    ${extractFunction('stationCountLabel')}
    ${extractFunction('mayUpdateSearchUi')}
    ${extractFunction('reportSearchError')}
    async ${extractFunction('loadStationsAt')}
    return { loadStationsAt, reportSearchError, newSearch: () => ++searchGeneration };
  `)(() => new Promise((resolve, reject) => { resolveFetch = resolve; rejectFetch = reject; }), log);

  // Search A reaches the map; while its stations load, search B starts geocoding.
  const loadA = h.loadStationsAt(1, 2, h.newSearch());
  h.newSearch();
  resolveFetch({ features: [] });
  assert.equal(await loadA, true, 'A still owns the map — no newer area exists');
  assert.ok(log.includes('plotted') && log.includes('alerts'));
  assert.ok(!log.includes('overlay hidden'), 'B (still geocoding) keeps its loading overlay');

  // B then fails before reaching the map: the status describes what is shown.
  h.reportSearchError('ZIP code "00000" not found');
  assert.deepEqual(log.slice(-3), ['toast:ZIP code "00000" not found', 'overlay hidden', 'status:ok:2 STATIONS']);

  // Reverse order: C reaches the map, D starts and FAILS while C still loads.
  // The map is still loading C, so it stays "loading" (no false ERROR)…
  log.length = 0;
  const loadC = h.loadStationsAt(3, 4, h.newSearch());
  h.newSearch();
  h.reportSearchError('Location access denied.');
  assert.deepEqual(log.slice(-3), ['toast:Location access denied.', 'overlay:Fetching weather stations…', 'status:loading:FETCHING STATIONS…']);
  // …and when C's stations land, the status shows them.
  resolveFetch({ features: [] });
  assert.equal(await loadC, true);
  assert.deepEqual(log.slice(-3), ['status:ok:2 STATIONS', 'overlay hidden', 'alerts']);

  // If such a still-shown area FAILS instead, its reason is reported (not silent).
  log.length = 0;
  const loadE = h.loadStationsAt(5, 6, h.newSearch());
  h.newSearch();
  h.reportSearchError('ZIP code "11111" not found');
  rejectFetch(new Error('No NOAA stations here — coverage is US only'));
  await assert.rejects(loadE);
  assert.deepEqual(log.slice(-3), ['toast:No NOAA stations here — coverage is US only', 'overlay hidden', 'status:error:ERROR']);
});

test('the ?station deep link follows the same area rule as searches', () => {
  const deepLink = html.slice(html.indexOf('if (stationParam) {'), html.indexOf('/* ── Other params ── */'));
  assert.match(deepLink, /const area = \+\+areaGeneration;/);
  assert.match(deepLink, /if \(area !== areaGeneration\) return;/);
  assert.match(deepLink, /if \(mayUpdateSearchUi\(gen\)\) \{/);
  // Its own failure is reported even after a newer search failed (no stuck overlay).
  assert.match(deepLink, /if \(gen !== searchGeneration && !\(area === areaGeneration && mayUpdateSearchUi\(gen\)\)\) return;/);
  assert.match(deepLink, /areaLoading = \{ status: 'LOADING STATION…'/);
  // Closing the panel only returns focus for keyboard use (no surprise map pan).
  assert.match(html, /e\.currentTarget\.matches\(':focus-visible'\)/);
});

test('hidden tabs pause alert polling and hard-reloaded tabs still get updates', () => {
  assert.match(extractFunction('refreshAlerts'), /if \(document\.hidden\) \{ alertsRefreshMissed = true; return; \}/);
  assert.match(html, /if \(reg\.waiting && hasActiveWorker\(\)\) announceUpdate\(\);/);
  // One live region for progress (the status bar), and no manifest fetch on file://.
  assert.match(html, /<div id="map-overlay">/);
  assert.match(html, /if \(location\.protocol !== 'file:'\) \{\s*const manifestLink/);
  assert.doesNotMatch(html, /<link rel="manifest"/);
});

test('links opened in a hidden tab still load (no flyTo on a 0×0 map)', () => {
  const calls = [];
  const fakeMap = size => ({
    getSize: () => size, getZoom: () => 6,
    setView: () => calls.push('setView'),
    flyTo: () => calls.push('flyTo')
  });
  const makeMove = (size, reduced = false) => vm.runInNewContext(`(${extractFunction('moveMapTo')})`, {
    map: fakeMap(size), prefersReducedMotion: { matches: reduced }
  });
  makeMove({ x: 0, y: 0 })(1, 2, 10);       // laid out while hidden: flyTo would throw NaN
  makeMove({ x: 800, y: 600 })(1, 2, 10);   // normal: animate
  makeMove({ x: 800, y: 600 }, true)(1, 2, 10);
  makeMove({ x: 800, y: 600 })(1, 2, 6);    // same zoom: just move, no flight dipping out
  assert.deepEqual(calls, ['setView', 'flyTo', 'setView', 'setView']);
  // …and the map re-measures itself once it is actually shown.
  assert.match(html, /new ResizeObserver\(\(\) => map\.invalidateSize\(\)\)/);
});

test('the search pin never blocks clicks on a station next to it', () => {
  // Only the 📍 takes clicks; its 90×52 marker box (label included) lets them
  // through to station badges underneath, and pin mode lets the 📍 through too.
  assert.match(extractFunction('buildPinIcon'), /className: 'dropped-pin-marker', iconSize: \[90, 52\]/);
  assert.match(html, /\.leaflet-marker-icon\.dropped-pin-marker\.leaflet-interactive \{ pointer-events: none; \}\s*\.dropped-pin-icon \{ pointer-events: auto; \}/);
  assert.match(html, /#map\.tap-mode \.dropped-pin-icon \{ pointer-events: none; \}/);
  // Station badges are drawn above the pin: one under the 📍 is still clickable.
  assert.match(extractFunction('showSearchPin'), /draggable: true,[\s\S]*?zIndexOffset: -1000,/);
  assert.match(html, /\.dropped-pin-coords \{[^}]*pointer-events: none;/);
});

test('search pin works by drop, click, tap, and keyboard', () => {
  // The pin is placed on a real `drop` (Escape-cancelled drags never fire it).
  const pinSection = html.slice(html.indexOf("dragPinBtn.addEventListener('dragstart'"),
                                html.indexOf('function triggerPinSearch('));
  assert.match(pinSection, /document\.addEventListener\('drop', e => \{[\s\S]*?placeDragPin\(/);
  assert.doesNotMatch(pinSection.slice(pinSection.indexOf("addEventListener('dragend'")).split('});')[0],
    /placeDragPin/, 'dragend must not place the pin');
  assert.match(pinSection, /setData\('text\/plain', ''\)/, 'Firefox needs drag data to start a drag');

  // Leaflet fires 'add' inside addTo(), so the key handler must bind directly.
  const pin = extractFunction('showSearchPin');
  assert.doesNotMatch(pin, /\.on\('add'/);
  assert.match(pin, /getElement\(\)\.addEventListener\('keydown'/);
  // Placing a pin searches there; showing one (for a found address) doesn't.
  assert.match(extractFunction('placeDragPin'), /showSearchPin\(lat, lng\);\s*triggerPinSearch\(lat, lng\);/);
  assert.doesNotMatch(pin.slice(0, pin.indexOf("on('dragend'")), /triggerPinSearch/);

  // Click/tap-to-place is wired for both pin buttons and passes through alert areas.
  assert.match(pinSection, /dragPinBtn\.addEventListener\('click'/);
  assert.match(pinSection, /tapPinBtn\.addEventListener\('click'/);
  assert.match(html, /#map\.tap-mode \.wx-alert-area,\s*#map\.tap-mode \.leaflet-marker-icon \{ pointer-events: none; \}/);
  // Keyboard users finish with Enter on the focused map; other searches end the mode.
  assert.match(pinSection, /mapEl\.addEventListener\('keydown'[\s\S]*?e\.key !== 'Enter'/);
  assert.match(extractFunction('doSearch'), /setTapMode\(false\);/);
  assert.match(extractFunction('placeDragPin'), /setTapMode\(false\);/);
  assert.doesNotMatch(html, /window\._wxmap|window\.placeDragPin/);
});

test('request timeout remains active while a JSON response body is read', async () => {
  const fetchImpl = async (_url, { signal }) => ({
    ok: true,
    status: 200,
    json: () => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('body aborted');
        error.name = 'AbortError';
        reject(error);
      });
    })
  });
  const fetchJsonWithTimeout = new Function('fetch', `
    async ${extractFunction('fetchJsonWithTimeout')}
    return fetchJsonWithTimeout;
  `)(fetchImpl);

  await assert.rejects(
    fetchJsonWithTimeout('https://example.test/slow.json', {}, 5),
    /Request timed out/
  );
});

test('API-provided NWS links cannot redirect browser fetches to another origin', () => {
  const isTrustedNwsApiUrl = new Function(`
    ${extractFunction('isTrustedNwsApiUrl')}
    return isTrustedNwsApiUrl;
  `)();

  assert.equal(isTrustedNwsApiUrl(
    'https://api.weather.gov/zones/forecast/TXZ205', '/zones/'), true);
  assert.equal(isTrustedNwsApiUrl(
    'https://api.weather.gov/gridpoints/EWX/155,90/forecast/hourly', '/gridpoints/'), true);
  assert.equal(isTrustedNwsApiUrl('http://api.weather.gov/zones/forecast/TXZ205', '/zones/'), false);
  assert.equal(isTrustedNwsApiUrl('https://api.weather.gov.evil.test/zones/x', '/zones/'), false);
  assert.equal(isTrustedNwsApiUrl('https://user@api.weather.gov/zones/x', '/zones/'), false);
  assert.equal(isTrustedNwsApiUrl('http://127.0.0.1/zones/x', '/zones/'), false);
  assert.equal(isTrustedNwsApiUrl('not a URL', '/zones/'), false);
  assert.match(extractFunction('fetchForecastPoP'),
    /isTrustedNwsApiUrl\(hourlyUrl, '\/gridpoints\/'\)/);
  assert.match(extractFunction('fetchZoneGeometry'),
    /isTrustedNwsApiUrl\(url, '\/zones\/'\)/);
  assert.match(extractFunction('fetchStations'),
    /isTrustedNwsApiUrl\(stationsUrl, '\/gridpoints\/'\)/);
});

test('station lookup uses the documented gridpoint flow and shares its /points answer', async () => {
  const requested = [];
  const alertStateCache = new Map();
  const fetchStations = new Function('fetchJsonWithTimeout', 'alertStateCache', 'isTrustedNwsApiUrl', `
    const ALERT_STATE_CACHE_LIMIT = 100;
    function setBoundedCache(cache, key, value) { cache.set(key, value); }
    ${extractFunction('pointStateCode')}
    async ${extractFunction('fetchStations')}
    return fetchStations;
  `)(async url => {
    requested.push(url);
    return url.includes('/points/')
      ? { response: { ok: true, status: 200 }, data: { properties: {
          observationStations: 'https://api.weather.gov/gridpoints/LWX/95,71/stations',
          relativeLocation: { properties: { state: 'VA' } } } } }
      : { response: { ok: true, status: 200 }, data: { features: [] } };
  }, alertStateCache, url => url.startsWith('https://api.weather.gov/gridpoints/'));

  await fetchStations(38.8867, -77.0947);
  assert.deepEqual(requested, [
    'https://api.weather.gov/points/38.8867,-77.0947',
    'https://api.weather.gov/gridpoints/LWX/95,71/stations'
  ]);
  assert.equal(alertStateCache.get('38.8867,-77.0947'), 'VA', 'alerts must not re-request /points');
});

test('manifest paths are portable and app versions stay synchronized', () => {
  assert.equal(manifest.id, './');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.start_url, './index.html');
  assert.equal(manifest.shortcuts[0].url, './index.html');

  const workerVersion = serviceWorker.match(/const APP_VERSION = '([^']+)'/)?.[1];
  const pageVersion = html.match(/const APP_VERSION_FALLBACK = '([^']+)'/)?.[1];
  assert.equal(pageVersion, workerVersion);
});

test('service worker owns only WX.MAP caches and precaches required runtime assets', () => {
  assert.match(serviceWorker, /OWNED_CACHE_PATTERN\.test\(k\) && k !== CACHE_NAME/);
  assert.match(serviceWorker, /cache\.addAll\(SHELL_REQUESTS\)/);
  assert.doesNotMatch(serviceWorker, /cache\.addAll\(SHELL_URLS\)\.catch/);
  assert.match(serviceWorker, /SHELL_ASSET_URLS\.has\(requestUrl\.href\)/);
  assert.match(serviceWorker, /const cache = await caches\.open\(CACHE_NAME\);\s*const cached = await cache\.match\(req\)/);
  assert.doesNotMatch(serviceWorker, /await caches\.match\(req\)/);
  assert.match(serviceWorker, /'\.\/leaflet\.css'/);
  assert.match(serviceWorker, /'\.\/leaflet\.js'/);
  assert.match(serviceWorker, /'\.\/LEAFLET-LICENSE\.txt'/);
  assert.match(serviceWorker, /cache\.match\('\.\/index\.html'\)/);
  assert.match(serviceWorker, /await cache\.put\(req/);
  assert.doesNotMatch(serviceWorker, /networkFirst/);
});

test('service worker installs atomically, isolates cache cleanup, and allowlists routing', async () => {
  const installListeners = loadServiceWorker({
    cachesImpl: { open: async () => ({ addAll: async () => { throw new Error('missing shell file'); } }) }
  });
  let installWork;
  installListeners.get('install')({ waitUntil(promise) { installWork = promise; } });
  await assert.rejects(installWork, /missing shell file/);

  let installedRequests = [];
  const freshInstallListeners = loadServiceWorker({
    cachesImpl: {
      open: async () => ({
        addAll: async requests => { installedRequests = requests; }
      })
    }
  });
  freshInstallListeners.get('install')({ waitUntil(promise) { installWork = promise; } });
  await installWork;
  assert.ok(installedRequests.length > 0);
  assert.ok(
    installedRequests.every(request => request.cache === 'reload'),
    'every release asset must bypass stale entries in the browser HTTP cache'
  );

  const deleted = [];
  const matchedRequests = [];
  const cache = {
    addAll: async () => {},
    match: async request => { matchedRequests.push(request); return { ok: true }; },
    put: async () => {}
  };
  const listeners = loadServiceWorker({
    cachesImpl: {
      open: async () => cache,
      keys: async () => [
        'wxmap-v3',
        'wxmap-v1.0.6',
        'wxmap-weather-stations-v1.14.1',
        'wxmap-weather-stations-v1.14.0',
        'wxmap-weather-stations-v1.13.7',
        'wxmap-weather-stations-v1.13.6',
        'wxmap-weather-stations-v1.13.5',
        'wxmap-weather-stations-v1.13.4',
        'wxmap-weather-stations-v1.13.3',
        'wxmap-weather-stations-v1.13.2',
        'wxmap-weather-stations-v1.13.1',
        'wxmap-weather-stations-v1.13.0',
        'wxmap-weather-stations-v1.12.1',
        'wxmap-weather-stations-v1.12.0',
        'wxmap-weather-stations-v1.11.0',
        'wxmap-weather-stations-v1.10.2',
        'wxmap-weather-stations-v1.10.1',
        'wxmap-weather-stations-v1.10.0',
        'wxmap-weather-stations-v1.9.4',
        'wxmap-weather-stations-v1.9.3',
        'wxmap-weather-stations-v1.9.2',
        'wxmap-weather-stations-v1.9.1',
        'wxmap-weather-stations-v1.9.0',
        'wxmap-weather-stations-v1.8.0',
        'wxmap-weather-stations-v1.7.0',
        'wxmap-weather-stations-v1.6.4',
        'wxmap-weather-stations-v1.6.3',
        'wxmap-weather-stations-v1.6.2',
        'wxmap-weather-stations-v1.6.1',
        'wxmap-weather-stations-v1.6.0',
        'wxmap-weather-stations-v1.5.2',
        'wxmap-weather-stations-v1.5.1',
        'wxmap-weather-stations-v1.5.0',
        'wxmap-weather-stations-v1.4.0',
        'wxmap-weather-stations-v1.3.3',
        'wxmap-weather-stations-v1.3.2',
        'wxmap-weather-stations-v1.3.1',
        'wxmap-weather-stations-v1.3.0',
        'wxmap-weather-stations-v1.2.3',
        'wxmap-weather-stations-v1.2.2',
        'wxmap-weather-stations-v1.2.1',
        'wxmap-weather-stations-v1.2.0',
        'wxmap-weather-stations-v1.1.32',
        'wxmap-weather-stations-v1.1.31',
        'wxmap-weather-stations-v1.1.30',
        'wxmap-weather-stations-v1.1.29',
        'wxmap-weather-stations-v1.1.28',
        'wxmap-weather-stations-v1.1.27',
        'wxmap-weather-stations-v1.1.26',
        'wxmap-weather-stations-v1.1.25',
        'wxmap-weather-stations-v1.1.24',
        'wxmap-weather-stations-v1.1.23',
        'wxmap-weather-stations-v1.1.22',
        'wxmap-weather-stations-v1.1.21',
        'wxmap-weather-stations-v1.1.20',
        'wxmap-weather-stations-v1.1.19',
        'wxmap-weather-stations-v1.1.18',
        'wxmap-weather-stations-v1.1.17',
        'wxmap-weather-stations-v1.1.16',
        'wxmap-weather-stations-v1.1.15',
        'wxmap-weather-stations-v1.1.14',
        'wxmap-weather-stations-v1.1.13',
        'wxmap-weather-stations-v1.1.12',
        'wxmap-weather-stations-v1.1.11',
        'wxmap-weather-stations-v1.1.10',
        'wxmap-weather-stations-v1.1.9',
        'wxmap-weather-stations-v1.1.8',
        'wxmap-weather-stations-v1.1.7',
        'wxmap-weather-stations-v1.1.6',
        'wxmap-weather-stations-v1.1.5',
        'wxmap-weather-stations-v1.1.4',
        'wxmap-weather-stations-v1.1.3',
        'wxmap-weather-stations-v1.1.2',
        'wxmap-weather-stations-v1.1.1',
        'wxmap-weather-stations-v1.1.0',
        'wxmap-weather-stations-v1.0.8',
        'wxmap-weather-stations-v1.0.7',
        'wxmap-weather-stations-v1.0.5',
        'wxmap-weather-stations-video-v1.0.0',
        'another-app-v1'
      ],
      delete: async name => { deleted.push(name); }
    }
  });
  let activateWork;
  listeners.get('activate')({ waitUntil(promise) { activateWork = promise; } });
  await activateWork;
  // Both sides sorted the same (as text): "v1.1.10" sorts before "v1.1.2".
  assert.deepEqual(deleted.sort(), [
    'wxmap-v1.0.6',
    'wxmap-v3',
    'wxmap-weather-stations-v1.0.5',
    'wxmap-weather-stations-v1.0.7',
    'wxmap-weather-stations-v1.0.8',
    'wxmap-weather-stations-v1.1.0',
    'wxmap-weather-stations-v1.1.1',
    'wxmap-weather-stations-v1.1.2',
    'wxmap-weather-stations-v1.1.3',
    'wxmap-weather-stations-v1.1.4',
    'wxmap-weather-stations-v1.1.5',
    'wxmap-weather-stations-v1.1.6',
    'wxmap-weather-stations-v1.1.7',
    'wxmap-weather-stations-v1.1.8',
    'wxmap-weather-stations-v1.1.9',
    'wxmap-weather-stations-v1.1.10',
    'wxmap-weather-stations-v1.1.11',
    'wxmap-weather-stations-v1.1.12',
    'wxmap-weather-stations-v1.1.13',
    'wxmap-weather-stations-v1.1.14',
    'wxmap-weather-stations-v1.1.15',
    'wxmap-weather-stations-v1.1.16',
    'wxmap-weather-stations-v1.1.17',
    'wxmap-weather-stations-v1.1.18',
    'wxmap-weather-stations-v1.1.19',
    'wxmap-weather-stations-v1.1.20',
    'wxmap-weather-stations-v1.1.21',
    'wxmap-weather-stations-v1.1.22',
    'wxmap-weather-stations-v1.1.23',
    'wxmap-weather-stations-v1.1.24',
    'wxmap-weather-stations-v1.1.25',
    'wxmap-weather-stations-v1.1.26',
    'wxmap-weather-stations-v1.1.27',
    'wxmap-weather-stations-v1.1.28',
    'wxmap-weather-stations-v1.1.29',
    'wxmap-weather-stations-v1.1.30',
    'wxmap-weather-stations-v1.1.31',
    'wxmap-weather-stations-v1.1.32',
    'wxmap-weather-stations-v1.2.0',
    'wxmap-weather-stations-v1.2.1',
    'wxmap-weather-stations-v1.2.2',
    'wxmap-weather-stations-v1.2.3',
    'wxmap-weather-stations-v1.3.0',
    'wxmap-weather-stations-v1.3.1',
    'wxmap-weather-stations-v1.3.2',
    'wxmap-weather-stations-v1.3.3',
    'wxmap-weather-stations-v1.4.0',
    'wxmap-weather-stations-v1.5.0',
    'wxmap-weather-stations-v1.5.1',
    'wxmap-weather-stations-v1.5.2',
    'wxmap-weather-stations-v1.6.0',
    'wxmap-weather-stations-v1.6.1',
    'wxmap-weather-stations-v1.6.2',
    'wxmap-weather-stations-v1.6.3',
    'wxmap-weather-stations-v1.6.4',
    'wxmap-weather-stations-v1.7.0',
    'wxmap-weather-stations-v1.8.0',
    'wxmap-weather-stations-v1.9.0',
    'wxmap-weather-stations-v1.9.1',
    'wxmap-weather-stations-v1.9.2',
    'wxmap-weather-stations-v1.9.3',
    'wxmap-weather-stations-v1.9.4',
    'wxmap-weather-stations-v1.10.0',
    'wxmap-weather-stations-v1.10.1',
    'wxmap-weather-stations-v1.10.2',
    'wxmap-weather-stations-v1.11.0',
    'wxmap-weather-stations-v1.12.0',
    'wxmap-weather-stations-v1.12.1',
    'wxmap-weather-stations-v1.13.0',
    'wxmap-weather-stations-v1.13.1',
    'wxmap-weather-stations-v1.13.2',
    'wxmap-weather-stations-v1.13.3',
    'wxmap-weather-stations-v1.13.4',
    'wxmap-weather-stations-v1.13.5',
    'wxmap-weather-stations-v1.13.6',
    'wxmap-weather-stations-v1.13.7',
    'wxmap-weather-stations-v1.14.0'
  ].sort());

  const routed = request => {
    let response;
    listeners.get('fetch')({ request, respondWith(value) { response = value; } });
    return response;
  };
  assert.equal(routed({ method: 'GET', mode: 'cors', url: 'https://example.test/weather/private.json' }), undefined);
  assert.equal(routed({ method: 'GET', mode: 'cors', url: 'https://api.weather.gov/alerts' }), undefined);
  assert.ok(routed({ method: 'GET', mode: 'cors', url: 'https://example.test/weather/leaflet.js' }));
  assert.ok(routed({ method: 'GET', mode: 'navigate', url: 'https://example.test/weather/index.html?zip=78201' }));
  assert.ok(routed({ method: 'GET', mode: 'navigate', url: 'https://example.test/weather/?lat=1&long=2' }));
  // Other pages in scope must reach the network instead of the app shell.
  assert.equal(routed({ method: 'GET', mode: 'navigate', url: 'https://example.test/weather/typo.html' }), undefined);
  assert.equal(routed({ method: 'GET', mode: 'navigate', url: 'https://example.test/weather/sw.js' }), undefined);
  // A #fragment must not hide an exact shell asset.
  assert.ok(routed({ method: 'GET', mode: 'cors', url: 'https://example.test/weather/leaflet.js#x' }));

  const licenseRequest = {
    method: 'GET', mode: 'navigate', url: 'https://example.test/weather/LEAFLET-LICENSE.txt'
  };
  await routed(licenseRequest);
  assert.ok(
    matchedRequests.includes(licenseRequest),
    'a direct license navigation must return the notice rather than the HTML app shell'
  );

  // A host that redirects /index.html → / leaves a "redirected" precache entry,
  // which browsers reject for navigations; the worker must serve a clean copy.
  const redirectedShell = new Response('<!doctype html>', { status: 200 });
  Object.defineProperty(redirectedShell, 'redirected', { value: true });
  const shellListeners = loadServiceWorker({
    cachesImpl: { open: async () => ({ match: async () => redirectedShell }) }
  });
  let shellResponse;
  shellListeners.get('fetch')({
    request: { method: 'GET', mode: 'navigate', url: 'https://example.test/weather/' },
    respondWith(value) { shellResponse = value; }
  });
  const served = await shellResponse;
  assert.equal(served.redirected, false);
  assert.equal(await served.text(), '<!doctype html>');
});

test('update flow survives file:// and blocked service-worker access', () => {
  // Reading navigator.serviceWorker is wrapped so a throwing getter or file:// page
  // cannot abort the registration script (and the version badge with it).
  assert.match(html, /const swContainer = \(\(\) => \{\s*try \{[\s\S]*?location\.protocol === 'file:'/);
  assert.doesNotMatch(html, /'serviceWorker' in navigator|navigator\.serviceWorker\.(controller|register|addEventListener)/);
});

/** Run the page's real update-flow block (if (swContainer) {...}) with stub objects. */
async function runUpdateFlow({ controller, active = null, waiting = null }) {
  const start = html.indexOf('if (swContainer) {');
  const block = html.slice(start, html.indexOf('} else {', start) + 1);
  const handlers = {};
  const reg = { active, waiting, addEventListener() {}, update: async () => {} };
  const swContainer = {
    controller,
    addEventListener: (type, fn) => { handlers[type] = fn; },
    register: async () => reg
  };
  const state = { reloads: 0, announced: 0 };
  const window = {
    location: { reload: () => { state.reloads++; } },
    dispatchEvent: () => { state.announced++; },
    addEventListener() {}
  };
  vm.runInNewContext(block, {
    swContainer, window, CustomEvent: class {},
    document: { addEventListener() {}, visibilityState: 'visible' },
    console: { info() {}, warn() {}, error() {} },
    setInterval() {}, setTimeout() {}, Date
  });
  await new Promise(resolve => setImmediate(resolve));   // let register() resolve
  return { state, change: () => handlers.controllerchange(), accept: () => window.__wxActivateUpdate() };
}

test('round-4 UI fixes: popups, keyboard panel, iOS zoom, cookies, fonts', () => {
  // A closed popup lingers in the DOM for Leaflet's 200 ms fade; ask the tracked owner.
  const openAlertPopupElement = vm.runInNewContext(
    `((activeAlertAreaOwner, livePopup = null) => (${extractFunction('openAlertPopupElement')})())`);
  assert.equal(openAlertPopupElement(null), null);
  const el = {};
  assert.equal(openAlertPopupElement({ getPopup: () => ({ getElement: () => el }) }), el);
  // A live-alert popup (14C) obeys the same Escape / click-away rules while open.
  assert.equal(openAlertPopupElement(null, { isOpen: () => true, getElement: () => el }), el);
  assert.equal(openAlertPopupElement(null, { isOpen: () => false, getElement: () => el }), null);
  assert.doesNotMatch(extractFunction('handleAlertPopupClickAway') + extractFunction('handleAlertPopupEscape'),
    /querySelector/);
  assert.match(extractFunction('addAlertGeometryToMap'), /autoPan: true, autoPanPadding: \[16, 16\]/);

  // Keyboard users can open a station (Leaflet never maps Enter to a marker click)
  // and close the panel with Escape.
  const marker = extractFunction('makeStationMarker');
  assert.match(marker, /openStation\(id, name, iconEl\);[\s\S]*?popupCloseBtn\.focus\(\);/);
  assert.match(marker, /if \(!e\.repeat\) openFromKeyboard\(\);/);
  assert.match(marker, /addEventListener\('keyup', e => \{\s*if \(e\.key === ' '\)/);
  // One page-wide guard: a held Enter "clicks" a focused button only once (FIND,
  // the pin button, alert toggles, and the panel's close button after a marker).
  assert.match(html, /document\.addEventListener\('keydown', e => \{\s*if \(e\.key === 'Enter' && e\.repeat && e\.target\.closest\?\.\('button'\)\) e\.preventDefault\(\);\s*\}, true\);/);
  // Border-colour-only focus styles add a transparent outline ON FOCUS for High
  // Contrast (in the base rule it would show on every unfocused control).
  for (const sel of ['.search-bar input {', '#drag-pin {', '#interval-input {']) {
    const base = html.slice(html.indexOf(sel), html.indexOf('}', html.indexOf(sel)));
    assert.match(base, /outline: none;/, sel);
    assert.doesNotMatch(base, /outline: 2px solid transparent/, `${sel} would ring every unfocused control`);
  }
  for (const sel of ['.search-bar input:focus', '#drag-pin:focus', '#interval-input:focus']) {
    const rule = html.slice(html.indexOf(sel), html.indexOf('}', html.indexOf(sel)));
    assert.match(rule, /outline: 2px solid transparent;/, sel);
  }
  // One Escape, one action: the alert popup handler skips a consumed key.
  assert.match(extractFunction('handleAlertPopupEscape'), /if \(event\.defaultPrevented\) return;/);
  assert.match(html, /popupPanel\.addEventListener\('keydown', e => \{\s*if \(e\.key !== 'Escape'\) return;/);

  assert.match(html, /\.weather-item-value \.na \{/);                 // the N/A span is a child
  assert.match(html, /#interval-input \{[^}]*font-size: 16px !important;/);   // no iOS zoom
  // Desktop: the refresh controls are big enough to read and hit.
  assert.match(html, /\.interval-wrap \{[^}]*font-size: 0\.7rem;/);
  assert.match(html, /#interval-input \{\s*width: 52px; height: 24px;[^}]*font-size: 0\.75rem;/);
  assert.match(html, /try \{\s*if \(document\.cookie\.includes\('wxmap_geocodio_key='\)\)/);
  assert.match(html, /rel="stylesheet" media="print" onload="this\.media='all'"/);
  assert.match(html, /<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin>/);
});

test('update flow reloads only pages that were running an older release', async () => {
  // First visit: the worker's initial claim must not reload (no flash).
  const first = await runUpdateFlow({ controller: null });
  first.change();
  assert.equal(first.state.reloads, 0);
  // …but a later update accepted in another window does reload it.
  first.change();
  assert.equal(first.state.reloads, 1);

  // Controlled page: an update taking over reloads exactly once.
  const normal = await runUpdateFlow({ controller: {}, active: {} });
  normal.change();
  normal.change();
  assert.equal(normal.state.reloads, 1);

  // Hard-reloaded page (uncontrolled, worker active): a new worker that activates
  // on its own must not reload it; an update the user accepts here must.
  const hard = await runUpdateFlow({ controller: null, active: {}, waiting: { postMessage() {} } });
  assert.equal(hard.state.announced, 1, 'a waiting update is still announced');
  hard.change();
  assert.equal(hard.state.reloads, 0);
  const hardAccepted = await runUpdateFlow({ controller: null, active: {}, waiting: { postMessage() {} } });
  hardAccepted.accept();
  hardAccepted.change();
  assert.equal(hardAccepted.state.reloads, 1);

  // The new worker already took over on its own (no waiting worker left): the
  // banner's REFRESH NOW must still work instead of silently doing nothing.
  const selfActivated = await runUpdateFlow({ controller: {}, active: {}, waiting: null });
  selfActivated.accept();
  assert.equal(selfActivated.state.reloads, 1);
});

test('rain chance uses the hour in progress, not an hour that already ended', async () => {
  const hour = 3_600_000, now = Date.now();
  const iso = ms => new Date(ms).toISOString();
  const forecastPoPCache = new Map();
  const fetchForecastPoP = new Function('fetchJsonWithTimeout', 'forecastPoPCache', `
    const FORECAST_TTL_MS = 600000, FORECAST_FAILURE_TTL_MS = 120000, FORECAST_CACHE_LIMIT = 100;
    function setBoundedCache(cache, key, value) { cache.set(key, value); }
    function isTrustedNwsApiUrl() { return true; }
    ${extractFunction('cachedForecastPoP')}
    async ${extractFunction('fetchForecastPoP')}
    return fetchForecastPoP;
  `)(async url => url.includes('/points/')
    ? { response: { ok: true }, data: { properties: { forecastHourly: 'https://api.weather.gov/gridpoints/X/1,1/forecast/hourly' } } }
    : { response: { ok: true }, data: { properties: { periods: [
        // An older forecast still starts with the hour that just ended.
        { endTime: iso(now - 60_000), probabilityOfPrecipitation: { value: 90 } },
        { endTime: iso(now + 60_000), probabilityOfPrecipitation: { value: 10 } },
        { endTime: iso(now + hour), probabilityOfPrecipitation: { value: 30 } }
      ] } } }, forecastPoPCache);

  assert.equal(await fetchForecastPoP(29.4, -98.5, 'KSAT'), 10);
  // Cached only until that hour ends (one minute away), not the usual 10 minutes.
  assert.ok(forecastPoPCache.get('KSAT').ttl <= 60_000);
  assert.ok(forecastPoPCache.get('KSAT').ttl > 0);
  // The hour's end is stored, so the panel's first render can drop it once over.
  assert.equal(forecastPoPCache.get('KSAT').end, Date.parse(iso(now + 60_000)));
  // The TTL comes from Number.isFinite, not `|| 10 min`: an hour ending right now
  // (difference 0) must not be cached for ten minutes.
  assert.match(extractFunction('fetchForecastPoP'), /Number\.isFinite\(periodEnd\) \? periodEnd - Date\.now\(\) : FORECAST_TTL_MS/);
});

test('shared coordinate links never use exponent notation', () => {
  let written = '';
  const push = vm.runInNewContext(`(() => { ${extractFunction('normalizeSearchText')} ${extractFunction('parseCoords')} ${extractFunction('pushQueryParam')} return pushQueryParam; })()`, {
    URLSearchParams, String, Number, parseFloat,
    window: { location: { pathname: '/' }, history: { replaceState: (s, t, url) => { written = url; } } }
  });
  push('coords', '0.0000001, 5');
  assert.equal(written, '/?lat=0&long=5');   // String(1e-7) would write "1e-7"
  push('coords', '29.4241, -98.4936');
  assert.equal(written, '/?lat=29.4241&long=-98.4936');
});

test('Enter that confirms an IME composition does not start a search', () => {
  // Safari ends the composition before keydown, so keyCode 229 is checked too.
  assert.match(html, /zipInput\.addEventListener\('keydown', e => \{\s*if \(e\.isComposing \|\| e\.keyCode === 229\) return;/);
});

test('the alert banner stays clear of the map controls and the station panel', () => {
  // Desktop: above the bottom-left zoom control and the LIVE ALERTS button above it;
  // beside an open panel in narrow windows.
  assert.match(html, /#alert-banner \{[^}]*max-height: max\(4rem, calc\(100% - 16px - 150px\)\);/);
  assert.match(html, /main\.sheet-open #alert-banner \{ max-width: calc\(100% - 16px - 314px - 32px\); \}/);
  // Phones: above the bottom-left controls and Locate Me, full width even with the sheet open.
  assert.match(html, /max-height: max\(4rem, calc\(100% - 8px - 160px - var\(--safe-bottom\)\)\);/);
  // …which sit low in the corner (zoom just above the version badge, the LIVE
  // ALERTS row just above the zoom) instead of halfway up the screen.
  assert.match(html, /\.leaflet-control-zoom \{ margin-bottom: calc\(38px \+ var\(--safe-bottom\)\) !important; \}\s*\.leaflet-bottom \.live-alerts-ctl \{ margin-bottom: 6px; \}/);
  assert.doesNotMatch(html, /margin-bottom: calc\(88px/);
  // An open or hovered station inside a warning keeps readable dark text.
  assert.match(html, /\.station-marker\.alerted:hover,\s*\.station-marker\.alerted\.active \{ color: var\(--bg\); \}/);
  // A rebuilt banner keeps keyboard focus (on the same control, else the summary
  // chip), its scroll position and what was open; the dead install-prompt hook is gone.
  const render = extractFunction('renderAlertBanner');
  assert.ok(render.indexOf('const focusKey = alertBannerFocusKey();') <
            render.lastIndexOf('alertBanner.innerHTML ='), 'focus must be noted before the rebuild');
  assert.match(render, /alertBanner\.scrollTop = scrollTop;\s*if \(focusKey !== null\) restoreAlertBannerFocus\(focusKey\);/);
  assert.match(extractFunction('restoreAlertBannerFocus'), /\(match \|\| alertBanner\.querySelector\('\[data-role="toggle"\]'\)\)\?\.focus\(\);/);
  // Focus rings on the banner's buttons are drawn inside (the banner clips).
  assert.match(html, /\.alert-summary:focus-visible,\s*\.alert-card-head:focus-visible,\s*\.alert-group-head:focus-visible,\s*\.alert-zoom:focus-visible,\s*(\/\*[\s\S]*?\*\/\s*)?\.alert-card-body:focus-visible \{ outline: 2px solid var\(--text\); outline-offset: -3px; \}/);
  assert.doesNotMatch(html, /pwaInstallPrompt/);
  // The phone override must come AFTER the desktop side-by-side rule to win.
  const desktopRule = html.indexOf('main.sheet-open #alert-banner { max-width: calc(');
  const phoneRule = html.search(/main\.sheet-open #alert-banner \{\s*max-width: none;\s*max-height: max\(4rem, calc\(100% - 8px - var\(--sheet-h, 70vh\) - 74px\)\);/);
  const mobileBlock = html.indexOf('@media (pointer: coarse), (max-width: 640px) {');
  assert.ok(desktopRule > 0 && mobileBlock > desktopRule && phoneRule > mobileBlock);
  // With the sheet open on phones, Locate Me is drawn above the banner.
  assert.match(html, /main\.sheet-open #fab-locate \{[^}]*z-index: 1150;/);
  // Delete on either pin button (touch devices only show the tap-pin) removes the pin.
  assert.match(html, /\[dragPinBtn, tapPinBtn\]\.forEach\(btn => btn\.addEventListener\('keydown'/);
});

test('ZIP lookup falls back to Photon when Nominatim cannot be reached', async () => {
  const requested = [];
  const zipToCoords = new Function('fetchJsonWithTimeout', `
    async ${extractFunction('zipToCoordsViaPhoton')}
    async ${extractFunction('zipToCoords')}
    return zipToCoords;
  `)(async url => {
    requested.push(url);
    // Nominatim's CDN answering without CORS surfaces as a network error.
    if (url.includes('nominatim')) throw new TypeError('Failed to fetch');
    return { response: { ok: true }, data: { features: [
      { properties: { countrycode: 'MX' }, geometry: { coordinates: [-99, 19] } },
      { properties: { countrycode: 'US' }, geometry: { coordinates: [-98.5, 29.4] } }
    ] } };
  });
  assert.deepEqual({ ...await zipToCoords('78201-1234') }, { lat: 29.4, lon: -98.5 });
  assert.match(requested[1], /^https:\/\/photon\.komoot\.io\/api\/\?q=78201&osm_tag=place:postcode/);
});

test('alert popups pan clear of the banner and panel, and their × never covers text', () => {
  // Content leaves room for the enlarged close button (32px; 44px on touch).
  assert.match(html, /\.wx-alert-popup \.leaflet-popup-content \{[^}]*margin: 14px 40px 14px 16px;/);
  assert.match(html, /\.wx-alert-popup \.leaflet-popup-content \{ margin-right: 52px; \}/);

  /** Run prepareAlertPopupPan for a click at (x, y) on a given layout. */
  const run = ({ x, y, map, panelStyle = 'absolute', panelRect, bannerBottom = 260 }) => {
    const options = {};
    const area = {};
    vm.runInNewContext(`(() => { ${extractFunction('fitAlertPopup')} return ${extractFunction('prepareAlertPopupPan')}; })()`, {
      alertAreaOwners: new Map([[area, { getPopup: () => ({ options }) }]]),
      document: { getElementById: () => ({ getBoundingClientRect: () => map }) },
      alertBanner: { classList: { contains: () => true }, getBoundingClientRect: () => ({ bottom: bannerBottom, right: 346 }) },
      popupPanel: { style: { display: 'block' }, getBoundingClientRect: () => panelRect },
      getComputedStyle: () => ({ position: panelStyle }),
      Math
    })({ target: { closest: () => area }, clientX: x, clientY: y });
    return { ...options, topLeft: [...options.autoPanPaddingTopLeft], bottomRight: [...options.autoPanPaddingBottomRight] };
  };
  const desktop = { top: 100, bottom: 700, left: 0, right: 1000, width: 1000, height: 600 };
  const panel = { left: 670, top: 116, bottom: 500 };

  // A click under the banner pans below it; near the panel, left of it.
  const near = run({ x: 200, y: 400, map: desktop, panelRect: panel });
  assert.deepEqual(near.topLeft, [16, 168]);
  assert.deepEqual(near.bottomRight, [338, 16]);
  assert.equal(near.maxWidth, 320);
  // A click far from both (right side, low down) doesn't pan for nothing.
  const far = run({ x: 600, y: 690, map: desktop, panelRect: { left: 670, top: 116, bottom: 200 } });
  assert.deepEqual(far.topLeft, [16, 16]);
  assert.deepEqual(far.bottomRight, [16, 16]);
  // Near the right edge of a narrow map Leaflet pushes the popup left, into the
  // banner's column, so the banner padding must apply after all.
  const narrow = { top: 100, bottom: 700, left: 0, right: 700, width: 700, height: 600 };
  const pushed = run({ x: 600, y: 690, map: narrow, panelRect: { left: 690, top: 116, bottom: 120 } });
  assert.deepEqual(pushed.topLeft, [16, 168]);
  // The panel's right padding pushes the popup left too: here the click alone
  // (560 - 200 = 360) clears the banner, but after the push (1100 - 438 - 400 = 262)
  // it doesn't — so the right padding must be computed before the banner check.
  const wide = { top: 100, bottom: 700, left: 0, right: 1100, width: 1100, height: 600 };
  const viaPanel = run({ x: 560, y: 450, map: wide, panelRect: { left: 670, top: 116, bottom: 500 } });
  assert.deepEqual(viaPanel.bottomRight, [438, 16]);
  assert.deepEqual(viaPanel.topLeft, [16, 168]);

  // Phone: full-width banner, bottom sheet, and a popup narrow enough that its ×
  // stays on a 360px screen.
  const phone = run({ x: 300, y: 150, map: { top: 95, bottom: 740, left: 0, right: 360, width: 360, height: 645 },
                      panelStyle: 'fixed', panelRect: { left: 0, top: 400, bottom: 740 }, bannerBottom: 180 });
  assert.equal(phone.maxWidth, 256);
  assert.deepEqual(phone.topLeft, [16, 93]);
  // The sheet would need 348px, but padding never exceeds half the map (322.5).
  assert.deepEqual(phone.bottomRight, [16, 322.5]);
  assert.ok(phone.maxHeight >= 120 && phone.maxHeight <= 645 - 93 - 322.5);

  assert.match(html, /document\.addEventListener\('click', prepareAlertPopupPan, \{ capture: true \}\);/);
});

test('older Safari and safe areas: close button, focus ring, map controls, tiles', () => {
  // matches(':focus-visible') throws before Safari 15.4 — the × must still close.
  assert.match(html, /try \{ fromKeyboard = e\.currentTarget\.matches\(':focus-visible'\); \} catch/);
  assert.match(html, /#fab-locate:focus \{ outline: 2px solid var\(--text\);/);
  assert.match(html, /\.leaflet-left \.leaflet-control \{ margin-left: calc\(10px \+ var\(--safe-left\)\) !important; \}/);
  assert.match(html, /L\.tileLayer\('https:\/\/tile\.openstreetmap\.org\/\{z\}\/\{x\}\/\{y\}\.png'/);
});

test('ZIP fallback: when it runs, and what it accepts', async () => {
  /** zipToCoords with a fake network: `nominatim` and `photon` return {ok,status,data} or throw. */
  const make = ({ nominatim, photon }) => {
    const calls = [];
    const fn = new Function('fetchJsonWithTimeout', `
      async ${extractFunction('zipToCoordsViaPhoton')}
      async ${extractFunction('zipToCoords')}
      return zipToCoords;
    `)(async url => {
      calls.push(url.includes('nominatim') ? 'nominatim' : 'photon');
      const r = url.includes('nominatim') ? nominatim() : photon();
      return { response: { ok: r.ok, status: r.status }, data: r.data };
    });
    return { fn, calls };
  };
  const us = (name, lon, lat) => ({ properties: { countrycode: 'US', name }, geometry: { coordinates: [lon, lat] } });

  // A real "not found" from Nominatim is final — no second lookup.
  const empty = make({ nominatim: () => ({ ok: true, data: [] }), photon: () => ({ ok: true, data: { features: [] } }) });
  await assert.rejects(empty.fn('00000'), /not found/);
  assert.deepEqual(empty.calls, ['nominatim']);

  // A rate limit / server error falls back to Photon, which must match the exact ZIP.
  const limited = make({ nominatim: () => ({ ok: false, status: 429 }),
    photon: () => ({ ok: true, data: { features: [us('12346', -1, 1), us('12345', -73.9, 42.8)] } }) });
  assert.deepEqual({ ...await limited.fn('12345') }, { lat: 42.8, lon: -73.9 });
  assert.deepEqual(limited.calls, ['nominatim', 'photon']);

  // Photon without a US match → not found (no foreign or merely similar code).
  const none = make({ nominatim: () => ({ ok: false, status: 503 }),
    photon: () => ({ ok: true, data: { features: [{ properties: { countrycode: 'ES', name: '10001' }, geometry: { coordinates: [2, 40] } }] } }) });
  await assert.rejects(none.fn('10001'), /not found/);
  assert.match(extractFunction('zipToCoordsViaPhoton'), /limit=50/);
});

test('round-9 fixes: narrow header, drag vs click, pin-mode banner, colours, Locate privacy', () => {
  assert.match(html, /\.search-bar input \{\s*flex: 1;\s*min-width: 0;/);
  // Drag vs click: run the real handler with Leaflet's "moved" flag still set.
  let closed = 0;
  const handler = pressInMap => vm.runInNewContext(`(${extractFunction('handleAlertPopupClickAway')})`, {
    pressStartedInMap: pressInMap,
    map: { dragging: { moved: () => true }, closePopup: () => { closed++; } },
    openAlertPopupElement: () => ({ contains: () => false }),
    alertAreaOwners: new Map(), activeAlertAreaOwner: {}, livePopup: null
  });
  const click = detail => ({ detail, target: { closest: () => null }, stopPropagation() {} });
  handler(true)(click(1));    // the click that ends a pan of the map: ignored
  assert.equal(closed, 0);
  handler(false)(click(1));   // a later click on the banner/panel/header: closes
  assert.equal(closed, 1);
  handler(true)(click(0));    // a keyboard "click" is never a drag: closes
  assert.equal(closed, 2);
  assert.match(html, /pressStartedInMap = map\.getContainer\(\)\.contains\(e\.target\);/);
  // Pin mode: panel and alert banner move below the pin-mode banner's real height.
  assert.match(html, /main:has\(#tap-place-banner\.active\) #popup-panel \{\s*top: calc\(var\(--tap-banner-h, 48px\) \+ 16px\);\s*max-height: calc\(100% - var\(--tap-banner-h, 48px\) - 32px\);/);
  assert.match(html, /main:has\(#tap-place-banner\.active\) #alert-banner \{\s*top: calc\(var\(--tap-banner-h, 48px\) \+ 16px\);/);
  // The phone versions must sit inside the mobile block, after the desktop ones.
  const mobileBlockAt = html.indexOf('@media (pointer: coarse), (max-width: 640px) {');
  const desktopPinAt = html.search(/main:has\(#tap-place-banner\.active\) #alert-banner \{\s*top: calc\(var\(--tap-banner-h, 48px\)/);
  const phonePinAt = html.search(/main:has\(#tap-place-banner\.active\) #alert-banner \{\s*top: calc\(var\(--tap-banner-h, 74px\) \+ 8px\);/);
  const phoneSheetPinAt = html.search(/main\.sheet-open:has\(#tap-place-banner\.active\) #alert-banner \{\s*max-height: max\(4rem, calc\(100% - var\(--tap-banner-h, 74px\) - 8px - var\(--sheet-h, 70vh\) - 74px\)\);/);
  assert.ok(desktopPinAt > 0 && desktopPinAt < mobileBlockAt, 'desktop pin rule before the mobile block');
  // The block closes at the first two-space-indented "}" line after it opens
  // (CRLF-tolerant, since a Windows checkout may convert line endings).
  const mobileBlockEnd = mobileBlockAt + html.slice(mobileBlockAt).search(/\r?\n  \}\r?\n/);
  assert.ok(phonePinAt > mobileBlockAt && phoneSheetPinAt > mobileBlockAt &&
            phonePinAt < mobileBlockEnd && phoneSheetPinAt < mobileBlockEnd, 'phone pin rules inside the mobile block');
  // Pin mode measures its banner with the text in before the first paint (no jump).
  assert.match(extractFunction('setTapMode'),
    /tapPlaceBanner\.textContent = TAP_BANNER_TEXT;\s*mapEl\.parentElement\.style\.setProperty\('--tap-banner-h'/);
  // The phone sheet's own cap is the one inside the mobile #popup-panel rule.
  const sheetRule = html.slice(html.indexOf('#popup-panel {', mobileBlockAt), html.indexOf('}', html.indexOf('#popup-panel {', mobileBlockAt)));
  assert.match(sheetRule, /max-height: 70vh !important;/);
  // Measured only once its text is in (no two-step move when the mode turns on).
  assert.match(html, /if \(!tapPlaceBanner\.textContent\) return;\s*mapEl\.parentElement\.style\.setProperty\('--tap-banner-h', `\$\{tapPlaceBanner\.offsetHeight\}px`\);/);
  assert.match(html, /max-height: 70vh !important;/);
  // The press tracker must see every press first (capture phase, on document).
  assert.match(html, /document\.addEventListener\('pointerdown', e => \{\s*pressStartedInMap = [^}]*\}, \{ capture: true \}\);/);
  // Alert text uses a lighter shade (≥4.5:1 for every hue) than the polygon.
  const add = extractFunction('addAlertGeometryToMap');
  assert.match(add, /const textColor = `hsl\(\$\{hue\}, 85%, 72%\)`;/);
  assert.match(add, /alertAreaPopupHtml\(props, textColor\)/);
  // Locate Me keeps the exact GPS fix out of the URL/history (3 decimals ≈ 110 m).
  assert.match(html, /placeDragPin\(\+lat\.toFixed\(3\), \+lng\.toFixed\(3\)\);/);
  // Older Safari keeps a visible focus ring on Locate Me.
  assert.match(html, /#fab-locate:focus:not\(:focus-visible\) \{ outline: none; \}/);
});

test('refresh interval input: exponent forms, empty field, clamping', () => {
  // Run the real change handler against a stub input.
  const start = html.indexOf("intervalInput.addEventListener('change', () => {");
  const body = html.slice(start, html.indexOf('\n});', start) + 4);
  const apply = value => {
    const ctx = { intervalInput: { value, addEventListener: (_t, fn) => { ctx.fn = fn; } },
      refreshInterval: 60_000, activeStationId: null, refreshTimer: null,
      MIN_REFRESH_SECONDS: 10, MAX_REFRESH_SECONDS: 3600, Math, Number };
    vm.runInNewContext(body, ctx);
    ctx.fn();
    return ctx.refreshInterval / 1000;
  };
  assert.equal(apply('1e3'), 1000, '"1e3" is a valid 1000, not 1');
  assert.equal(apply(''), 60, 'a cleared field keeps the current rate');
  assert.equal(apply('abc'), 60);
  assert.equal(apply('5'), 10);
  assert.equal(apply('99999'), 3600);
  // At max/min zoom the useless + or − looks disabled (our colour override is
  // !important, so Leaflet's own greyed-out style needs restoring), and the
  // pin-mode banner keeps its text out of a landscape notch.
  assert.match(html, /\.leaflet-control-zoom a\.leaflet-disabled \{ color: var\(--text-muted\) !important; cursor: default; \}/);
  assert.match(html, /padding: 7px calc\(12px \+ var\(--safe-right\)\) 7px calc\(12px \+ var\(--safe-left\)\);/);
  // The touch pin button centres its icon like the desktop one.
  assert.match(html, /#tap-pin-btn \{ display: flex !important; align-items: center; justify-content: center; padding: 0; \}/);
});

test('the sky row shows the main cloud deck, not just the lowest layer', () => {
  // Pull the layer-picking lines out of renderWeather and run them.
  const src = extractFunction('renderWeather');
  const pick = src.slice(src.indexOf('const coverRank'), src.indexOf('const cloudAmt'));
  const choose = layers => vm.runInNewContext(`(() => { const p = { cloudLayers: ${JSON.stringify(layers)} }; ${pick}; return layer; })()`);
  // Live KSAT case: FEW 460 m, BKN 610 m, OVC 790 m → overcast, not "Few".
  assert.equal(choose([{ amount: 'FEW', base: { value: 460 } }, { amount: 'BKN', base: { value: 610 } },
                       { amount: 'OVC', base: { value: 790 } }]).amount, 'OVC');
  // Tie → the lowest layer (it sets the ceiling).
  assert.equal(choose([{ amount: 'BKN', base: { value: 300 } }, { amount: 'BKN', base: { value: 900 } }]).base.value, 300);
  assert.equal(choose([]), undefined);
  assert.match(html, /Precip Chance \(this hr\)/);
});

// escapeHtml's regexes contain quote characters that extractFunction's simple
// tokenizer would read as strings, so take it with a plain match instead.
const escapeHtmlSource = html.match(/function escapeHtml\(s\) \{[\s\S]*?\r?\n\}/)[0];
/** The forecast rows' sun, air and pressure helpers, to run in a vm alongside the renderers. */
const forecastExtrasSource = ['sunTimes', 'isoOffsetMinutes', 'clockLabel', 'durationLabel', 'utcHourKey',
  'hasAir', 'hasPressure', 'aqiCategory', 'aqiHtml', 'hpaToInHg', 'forecastRowExtras'].map(extractFunction).join('\n');

test('station panel shows what weather.gov would: rounding, calm, clear, feels-like, pressure', () => {
  // Run the real renderWeather (and its helpers) against a stub page.
  const consts = ['toFixedClean', 'cToF', 'kmhToMph', 'mToMi', 'mToFt', 'paToInHg']
    .map(name => html.match(new RegExp(`const ${name} = [\\s\\S]*?;\\r?\\n(?=\\r?\\n|/\\*\\*|const )`))[0]).join('\n');
  const elements = {};
  const render = vm.runInNewContext(`(() => {
    ${consts}
    ${escapeHtmlSource}
    ${extractFunction('val')}
    ${extractFunction('degToCompass')}
    ${extractFunction('formatTime')}
    ${extractFunction('setBoundedCache')}
    const GUST_CARRY_MS = 15 * 60_000, GUST_MEMORY_LIMIT = 50;
    const recentGusts = new Map();
    ${extractFunction('shownGust')}
    ${extractFunction('renderWeather')}
    return renderWeather;
  })()`, {
    document: { getElementById: id => (elements[id] ||= {}) },
    popupPanel: { style: {} }, Date, Math, String, Number
  });
  const obs = props => render({ properties: { timestamp: new Date().toISOString(), ...props } }, 'KTST', 'Test');
  const body = () => elements['popup-body'].innerHTML.replace(/\s+/g, ' ');

  // KDEN-like: whole °C, 6 kt wind, OVC026 reported as 792.48 m.
  obs({ temperature: { value: 13 }, windSpeed: { value: 11.124 }, windDirection: { value: 350 },
        cloudLayers: [{ amount: 'FEW', base: { value: 457.2 } }, { amount: 'OVC', base: { value: 792.48 } }] });
  assert.match(body(), /55<sup>°F<\/sup>/);
  assert.match(body(), /13<sup>°C<\/sup>/);
  assert.match(body(), /7 mph/);
  assert.match(body(), /Overcast @ 2600 ft/);

  // Gusts: shown when reported; "None" when the wind isn't gusting (N/A only with
  // no wind data); a gust from the last 15 minutes carries over a report that
  // leaves it out (the 5-minute reports often do), with its age.
  const gustRow = () => body().match(/Gusts<\/div> <div class="weather-item-value">(.*?)<\/div>/)[1];
  const at = min => new Date(Date.parse('2026-10-02T03:00:00Z') + min * 60_000).toISOString();
  obs({ timestamp: at(0), windSpeed: { value: 33.3 }, windGust: { value: 48.2 } });
  assert.equal(gustRow(), '30 mph');
  obs({ timestamp: at(5), windSpeed: { value: 37 }, windGust: { value: null } });
  assert.match(gustRow(), /^30 mph<br><span[^>]*>5 min ago<\/span>$/);
  obs({ timestamp: at(20), windSpeed: { value: 37 }, windGust: { value: null } });
  assert.equal(gustRow(), '<span class="na">None</span>', 'over 15 minutes old: no longer shown');
  obs({ timestamp: at(21), windGust: { value: null } });
  assert.equal(gustRow(), '<span class="na">N/A</span>', 'no wind data at all');

  // PANC-like calm (00000KT) and an automated CLR with its 3810 m placeholder.
  obs({ windSpeed: { value: 0 }, windDirection: { value: 0 }, cloudLayers: [{ amount: 'CLR', base: { value: 3810 } }] });
  assert.match(body(), /Calm/);
  assert.doesNotMatch(body(), /from N/);
  assert.match(body(), /Clear\s*</);
  assert.doesNotMatch(body(), /12500/);

  // Visibility as reported: 1/4 SM (402.34 m) and 3/4 SM, 10 SM as whole miles.
  obs({ visibility: { value: 402.34 } });
  assert.match(body(), /0\.25 mi/);
  obs({ visibility: { value: 1207.01 } });
  assert.match(body(), /0\.75 mi/);
  obs({ visibility: { value: 5632.7 } });   // 5-minute reports send 3.5 mi
  assert.match(body(), />3\.5 mi/);
  obs({ visibility: { value: 16093.44 } });
  assert.match(body(), />10 mi/);

  // Fog hides the sky: VV is a vertical visibility, not a cloud base.
  obs({ cloudLayers: [{ amount: 'VV', base: { value: 60.96 } }] });
  assert.match(body(), /Obscured · vert\. vis\. 200 ft/);

  // KPHX-like mild heat index (73°F) is not shown; a real one (90°F) is.
  obs({ temperature: { value: 23 }, heatIndex: { value: 22.9 } });
  assert.doesNotMatch(body(), /Heat Index/);
  obs({ temperature: { value: 32.2 }, heatIndex: { value: 36 } });
  assert.match(body(), /Heat Index/);

  // KLXV-like: altimeter setting 102675 Pa (30.32) wins over sea-level 101730 Pa.
  obs({ barometricPressure: { value: 102675 }, seaLevelPressure: { value: 101730 } });
  assert.match(body(), /30\.32 inHg/);

  // Present weather in words, and dropped when it repeats the description.
  obs({ textDescription: 'Light Rain', presentWeather: [{ intensity: 'light', weather: 'rain', rawString: '-RA' }] });
  assert.doesNotMatch(body(), /-RA|light rain<\/span>/i);
  obs({ textDescription: 'Mist', presentWeather: [{ intensity: 'light', weather: 'rain', rawString: '-RA' }] });
  assert.match(body(), /light rain/);

  // Cutoffs follow the °F shown: 26.6°C reads 80°F (heat index), 10.2°C reads 50°F.
  obs({ temperature: { value: 26.6 }, heatIndex: { value: 27.5 } });
  assert.match(body(), /Heat Index/);
  obs({ temperature: { value: 10.2 }, windSpeed: { value: 9.3 }, windChill: { value: 9 } });
  assert.match(body(), /Wind Chill/);
  // 2 kt (shown as 2 mph) is below the 3 mph wind-chill cutoff.
  obs({ temperature: { value: 3 }, windSpeed: { value: 3.7 }, windChill: { value: 2 } });
  assert.doesNotMatch(body(), /Wind Chill/);
  obs({ temperature: { value: 3 }, windSpeed: { value: 5.5 }, windChill: { value: 1 } });
  assert.match(body(), /Wind Chill/);
  // 4.5 km/h is shown as 3 mph, so the shown wind meets the 3 mph cutoff too.
  obs({ temperature: { value: 3 }, windSpeed: { value: 4.5 }, windChill: { value: 1 } });
  assert.match(body(), /Wind Chill/);
  // "Fog/Mist" vs fog_mist is the same thing — not repeated.
  obs({ textDescription: 'Fog/Mist', presentWeather: [{ weather: 'fog_mist' }] });
  assert.doesNotMatch(body(), /fog mist/);
  // Showers read in plain English.
  obs({ textDescription: 'Mist', presentWeather: [{ intensity: 'light', modifier: 'showers', weather: 'rain' }] });
  assert.match(body(), /light rain showers/);
  // NWS joins two items with "and" (KMKE-like) — still the same thing.
  obs({ textDescription: 'Light Rain and Fog/Mist',
        presentWeather: [{ intensity: 'light', weather: 'rain' }, { weather: 'fog_mist' }] });
  assert.doesNotMatch(body(), /fog mist/);
  // Showers seen only nearby (VCSH) say so.
  obs({ textDescription: ' Rain', presentWeather: [{ modifier: 'showers', weather: 'rain', inVicinity: true }] });
  assert.match(body(), /rain showers in vicinity/);
  // NWS words for BCFG and UP (KPKB-, KAIO-like) match, so they are not repeated.
  obs({ textDescription: 'Fog/Mist and Patchy Fog', presentWeather: [{ weather: 'fog_mist' }, { modifier: 'patches', weather: 'fog' }] });
  assert.doesNotMatch(body(), /patch|fog mist/);
  obs({ textDescription: 'Light Unknown Precipitation', presentWeather: [{ intensity: 'light', weather: 'unknown' }] });
  assert.doesNotMatch(body(), /light unknown/);
  // A 3-hour-old report gets an age.
  render({ properties: { timestamp: new Date(Date.now() - 3 * 3_600_000).toISOString() } }, 'KTST', 'Test');
  assert.match(elements['update-time'].textContent, /3 h old/);
  // A two-day-old "latest" report says so.
  render({ properties: { timestamp: new Date(Date.now() - 49 * 3_600_000).toISOString() } }, 'KTST', 'Test');
  assert.match(elements['update-time'].textContent, /2 days old/);
});

test('alert times never invent an end and show a future start', () => {
  const helpers = `
    ${escapeHtmlSource}
    ${extractFunction('formatWhen')}
    ${extractFunction('alertEndText')}`;
  const popup = vm.runInNewContext(`(() => { ${helpers} ${extractFunction('alertAreaPopupHtml')} return alertAreaPopupHtml; })()`, { Date });
  // A flood warning "until further notice": ends null, expires = next update.
  const flood = { event: 'Flood Warning', onset: '2026-10-01T08:00:00-05:00', ends: null,
                  expires: '2026-10-01T20:00:00-05:00' };
  const whenIn = vm.runInNewContext(`(() => { ${extractFunction('formatWhen')} return formatWhen; })()`, { Date });
  assert.match(popup(flood, 'red'), /&rarr; <b>further notice<\/b>/);
  // A set end is shown as-is.
  const ends = '2026-10-02T06:00:00-05:00';
  assert.ok(popup({ ...flood, ends }, 'red').includes(`&rarr; <b>${whenIn(ends)}</b>`));
  // A short statement without `ends` simply lasts until its message expires.
  const statement = popup({ ...flood, event: 'Special Weather Statement' }, 'red');
  assert.doesNotMatch(statement, /further notice|until/);
  assert.ok(statement.includes(whenIn(flood.expires)));

  // Run the real banner: a warning starting tomorrow with no set end.
  const banner = { className: '', innerHTML: '', scrollTop: 0, scrollHeight: 0, clientHeight: 0,
                   contains: () => false, querySelector: () => null, classList: { toggle() {}, contains: () => true } };
  const bannerCtx = {
    Date, String, Set, Map, alertBanner: banner, document: {}, alertBannerCollapsed: false,
    openAlertGroups: new Set(), openAlertCards: new Set(), alertRecordCache: new Map(),
    alertRecordWanted: new Set(['b']), alertRecordInFlight: new Map(), alertRecordFailedAt: new Map(),
    ALERT_CLASS_RANK: { crit: 0, warn: 1, watch: 2, info: 3 },
    ALERT_SEV_WEIGHT: {}, ALERT_URGENCY_WEIGHT: {}, ALERT_CERTAINTY_WEIGHT: {}
  };
  const render = vm.runInNewContext(`(() => {
    ${helpers}
    ${extractFunction('unwrapAlertText')}
    ${extractFunction('alertClass')}
    ${extractFunction('compareAlertDanger')}
    ${extractFunction('sortAlerts')}
    ${extractFunction('alertWhenHtml')}
    ${extractFunction('alertPlacesText')}
    ${extractFunction('alertId')}
    ${extractFunction('alertAreaDesc')}
    ${extractFunction('alertRecordPending')}
    ${extractFunction('alertCardHtml')}
    ${extractFunction('alertGroupHtml')}
    ${extractFunction('alertBannerFocusKey')}
    ${extractFunction('updateAlertScrollHint')}
    ${extractFunction('renderAlertBanner')}
    return renderAlertBanner;
  })()`, bannerCtx);
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
  render([{ id: 'a', properties: { ...flood, onset: tomorrow } }]);
  assert.match(banner.innerHTML, /<span class="alert-when">from [^<]+<\/span> <span class="alert-when">until further notice<\/span>/);
  assert.equal(banner.className, 'visible expanded', 'expanded on arrival');

  // Once the user collapses it, later renders (refreshes, new searches) keep it collapsed.
  bannerCtx.alertBannerCollapsed = true;
  render([{ id: 'a', properties: flood }]);
  assert.equal(banner.className, 'visible');
  assert.match(banner.innerHTML, /data-role="toggle" aria-expanded="false"/);
  // Live mode lists the alerts in view; their cards fetch the NWS text when opened.
  render([{ id: 'b', properties: { event: 'Flood Warning', ends: tomorrow,
    detailsUrl: 'https://api.weather.gov/alerts/urn:oid:x"><b>' } }], true);
  assert.match(banner.innerHTML, /1 alert in view · Flood Warning/);
  assert.match(banner.innerHTML, /<div class="alert-card-body" data-details-url="https:\/\/api\.weather\.gov\/alerts\/urn:oid:x&quot;&gt;&lt;b&gt;">/);
  assert.match(banner.innerHTML, /Loading the full NWS text…/);
  assert.match(banner.innerHTML, /<span class="alert-places">Finding the places…<\/span>/);
  // Only while its lookup is queued or running: otherwise no places line at all.
  bannerCtx.alertRecordWanted.clear();
  render([{ id: 'b', properties: { event: 'Flood Warning', ends: tomorrow,
    detailsUrl: 'https://api.weather.gov/alerts/urn:oid:x' } }], true);
  assert.doesNotMatch(banner.innerHTML, /Finding the places|alert-places/);
  // A card rebuilt after its lookup failed (none on its way) says so — not "Loading…".
  bannerCtx.alertRecordFailedAt.set('b', Date.now());
  render([{ id: 'b', properties: { event: 'Flood Warning', ends: tomorrow,
    detailsUrl: 'https://api.weather.gov/alerts/urn:oid:x' } }], true);
  assert.match(banner.innerHTML, /Couldn&#39;t load the details — close and reopen the card to try again\./);
  assert.doesNotMatch(banner.innerHTML, /Loading the full NWS text/);
  // …while one on its way still says "Loading…".
  bannerCtx.alertRecordWanted.add('b');
  render([{ id: 'b', properties: { event: 'Flood Warning', ends: tomorrow,
    detailsUrl: 'https://api.weather.gov/alerts/urn:oid:x' } }], true);
  assert.match(banner.innerHTML, /Loading the full NWS text…/);

  // Where each alert applies is on its header; same-type alerts fold into one
  // group row (count, shared time, their places) that opens to their cards, each
  // opening first to "Show this area on the map" for that one alert (no
  // group-wide zoom); a type with one alert stays a plain card. The banner ends
  // with the "more below" bar shown while the list continues.
  bannerCtx.alertBannerCollapsed = false;
  const heat = (id, area) => ({ id, properties: { id, event: 'Extreme Heat Warning', severity: 'Severe',
    ends: tomorrow, areaDesc: area } });
  render([heat('h1', 'Pima; Pinal'), heat('h2', 'Maricopa'), heat('h3', 'Yuma; La Paz'),
          { id: 'a1', properties: { id: 'a1', event: 'Heat Advisory', ends: tomorrow, areaDesc: 'Mohave' } }]);
  const out = banner.innerHTML;
  assert.match(out, /4 alerts · Extreme Heat Warning/);
  assert.match(out, /<div class="alert-group alert-\w+" data-group="Extreme Heat Warning">/);
  assert.match(out, /<span class="alert-group-count"><span aria-hidden="true">×3<\/span><span class="sr-only">3 alerts<\/span><\/span>/);
  assert.match(out, /<span class="alert-places">Pima · Pinal · Maricopa \+2 more<\/span>/);
  assert.doesNotMatch(out, /zoom-group|Show all/);
  assert.equal((out.match(/data-role="card"/g) || []).length, 4, 'every alert keeps its own card');
  assert.match(out, /data-alert-id="a1"[\s\S]*?<span class="alert-places">Mohave<\/span>/);
  assert.equal((out.match(/<div class="alert-card-body"><button class="alert-zoom" type="button" data-role="zoom">📍 Show this area on the map<\/button>/g) || []).length, 4);
  assert.doesNotMatch(out, /data-group="Heat Advisory"/, 'a single alert is a plain card');
  assert.match(out, /<div class="alert-more" aria-hidden="true">▾ More alerts below<\/div>$/);
  // Background record loads: one request per alert at a time (an opened card
  // shares it), and a failed one rests for 5 minutes before the loader retries.
  const load = extractFunction('loadAlertRecord');
  assert.match(load, /if \(alertRecordInFlight\.has\(id\)\) return alertRecordInFlight\.get\(id\);/);
  // A failed lookup redraws the list too, so no header keeps "Finding the places…".
  assert.match(load, /setBoundedCache\(alertRecordFailedAt, id, Date\.now\(\), ALERT_RECORD_CACHE_LIMIT\);[\s\S]*?scheduleLiveBannerRefresh\(\);\s*return false;/);
  assert.match(extractFunction('queueAlertRecords'), /Date\.now\(\) - \(alertRecordFailedAt\.get\(id\) \?\? -Infinity\) < ALERT_RECORD_RETRY_MS/);
  assert.match(extractFunction('loadAlertCardDetails'), /updateAlertScrollHint\(\);\s*\/\/ the card's new height/);
  // "Show this area on the map" then picks the area out once the map has landed
  // (a newer zoom wins): glow, moving dashed outline, a flash and its name — gone
  // after a few seconds or at a click on the map, and never taking clicks.
  const zoom = extractFunction('zoomToAlert');
  assert.match(zoom, /const seq = \+\+alertFocusSeq;[\s\S]*if \(shown \|\| seq !== alertFocusSeq\) return;[\s\S]*showAlertFocus\(shapes, label, center\);/);
  // (Listening only once the short flight has begun: a glide it cuts short ends
  // with a "moveend" of its own.)
  assert.match(zoom, /map\.flyToBounds\(bounds, \{ \.\.\.options, duration: ALERT_FOCUS_FLIGHT_S \}\);[\s\S]*?map\.once\('moveend', show\);/);
  assert.match(html, /const ALERT_FOCUS_FLIGHT_S = 0\.6;/);
  // A new search takes it away too.
  assert.match(extractFunction('loadStationsAt'), /clearStations\(\);\s*clearAlertFocus\(\);/);
  const focus = extractFunction('showAlertFocus');
  assert.match(focus, /className: 'alert-focus-halo'[\s\S]*className: 'alert-focus-line'[\s\S]*dashArray: '10 8'/);
  assert.match(focus, /map\.on\('click', clearAlertFocus\);[\s\S]*alertFocusPanes\.forEach\(pane => pane\.classList\.add\('fading'\)\);[\s\S]*setTimeout\(clearAlertFocus, ALERT_FOCUS_FADE_MS\)/);
  assert.match(focus, /pane: 'alertFocusLabel'/);
  assert.match(extractFunction('clearAlertFocus'), /alertFocusLayer\.clearLayers\(\);[\s\S]*map\.off\('click', clearAlertFocus\);/);
  assert.match(html, /\.leaflet-alertFocus-pane,\s*\.leaflet-alertFocusLabel-pane \{ pointer-events: none; transition: opacity 0\.8s ease; \}/);
  // What the user opened stays open when the list is rebuilt.
  bannerCtx.openAlertGroups.add('Extreme Heat Warning');
  bannerCtx.openAlertCards.add('h2');
  render([heat('h1', 'Pima'), heat('h2', 'Maricopa')]);
  assert.match(banner.innerHTML, /<div class="alert-group alert-\w+ open"/);
  assert.match(banner.innerHTML, /<div class="alert-card alert-\w+ open" data-alert-id="h2">/);
});

test('the hidden toast never makes the page taller than the window', () => {
  // An absolute box parked 80px below the screen let focus() scroll the whole app.
  assert.match(html, /#toast \{[^}]*position: fixed;/);
});

test('vendored Leaflet and its license match the pinned release', () => {
  const digest = value => createHash('sha256').update(value).digest('base64');
  assert.equal(digest(leafletCss), 'p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=');
  assert.equal(digest(leafletJs), '20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=');
  assert.equal(digest(layersImage), 'Hbvp0CjikvNvy6j4s6KNXokydU/CIVuaxp5M3s9RB8Y=');
  assert.equal(digest(layersRetinaImage), 'Bm2sqFDY/77wB68AsG6sABVyje4nnFHzy2xxbffELt8=');
  assert.equal(digest(markerImage), 'V0w6XMqF9BFAhbaEFZbWLwDXyJLHsD8oy/owHesdxDc=');
  assert.match(leafletJs.slice(0, 200), /Leaflet 1\.9\.4/);
  assert.equal(leafletSourceMap.version, 3);
  assert.ok(leafletSourceMap.sources.includes('../src/map/Map.js'));
  assert.match(leafletLicense, /BSD 2-Clause License/);
  assert.match(leafletLicense, /Copyright \(c\) 2010-2023, Volodymyr Agafonkin/);
  assert.match(leafletLicense, /Redistributions of source code must retain/);
  assert.match(leafletLicense, /THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"/);
  assert.match(html, /href="\.\/leaflet\.css"/);
  assert.match(html, /src="\.\/leaflet\.js"/);
  assert.match(html, /href="\.\/LEAFLET-LICENSE\.txt"[^>]*rel="license noopener"/);
  assert.doesNotMatch(html, /unpkg\.com\/leaflet/);
});

test('alert popup opens only on click and keeps readable typography', () => {
  const addGeometry = extractFunction('addAlertGeometryToMap');
  assert.match(addGeometry, /className: 'wx-alert-area'/);
  assert.match(addGeometry, /layer\.bindPopup\(/);
  assert.doesNotMatch(addGeometry, /layer\.on\(/);
  assert.doesNotMatch(addGeometry, /mouseover|mouseout|pointerleave|popupPinned/);
  assert.doesNotMatch(html, /alertPopupDismissedAt|alertPopupHoverSuppressed|shouldSuppressAlertPopupHover/);
  assert.match(html, /\.wx-alert-pop-head \{ font-size: 0\.875rem/);
  assert.match(html, /\.wx-alert-pop-area \{ font-size: 0\.85rem/);
  assert.match(html, /\.wx-alert-popup \.leaflet-popup-tip \{[^}]*pointer-events:\s*none/s,
    'the decorative tip must not intercept an exact second click at the popup anchor');
  assert.match(html, /\.wx-alert-popup a\.leaflet-popup-close-button:focus-visible/);
});

test('alert banner text is phone-readable and NWS hard wraps are unwrapped', () => {
  // Banner body text must stay at least as large as the alert-area popup text.
  assert.match(html, /\.alert-desc \{[^}]*font-size: 0\.85rem/s);
  assert.match(html, /\.alert-headline \{[^}]*font-size: 0\.9rem/s);

  const unwrapAlertText = vm.runInNewContext(`(${extractFunction('unwrapAlertText')})`);
  // Typical NWS product: lines wrapped mid-sentence, paragraphs split by blank lines.
  const raw = '* WHAT...Southwest winds 15 to 25 mph with gusts up to 45 mph\r\n' +
    'expected.\r\n\r\n* WHERE...Portions of central and\n  eastern Virginia.\n\n\n' +
    'Use extra caution\nwhen driving.\n* Secure outdoor objects.';
  assert.equal(unwrapAlertText(raw),
    '* WHAT...Southwest winds 15 to 25 mph with gusts up to 45 mph expected.\n\n' +
    '* WHERE...Portions of central and eastern Virginia.\n\n' +
    'Use extra caution when driving.\n* Secure outdoor objects.');
  assert.equal(unwrapAlertText(null), '');
  // The NWS "&&" end-of-section marker is not shown to readers.
  assert.equal(unwrapAlertText('Stay indoors.\n\n&&\n\nMore later.'), 'Stay indoors.\n\nMore later.');

  // The banner must unwrap both parts before joining them.
  assert.match(extractFunction('alertCardHtml'), /\.map\(unwrapAlertText\)/);
});

test('alert popup selection toggles, switches areas, and closes on click-away or Escape', () => {
  let activePopup = null;
  let closeCount = 0;
  // The handlers ask which popup is open (tracked state), never the DOM.
  const openAlertPopupElement = () => activePopup;
  const mapStub = { closePopup: () => { closeCount++; } };
  const activeAreaElement = {};
  const siblingAreaElement = {};
  const differentAreaElement = {};
  const activeAlertAreaOwner = {};
  const differentAlertAreaOwner = {};
  const alertAreaOwners = new WeakMap([
    [activeAreaElement, activeAlertAreaOwner],
    [siblingAreaElement, activeAlertAreaOwner],
    [differentAreaElement, differentAlertAreaOwner]
  ]);
  const clickAway = new Function('openAlertPopupElement', 'map', 'alertAreaOwners', 'activeAlertAreaOwner', 'livePopup', `
    ${extractFunction('handleAlertPopupClickAway')}
    return handleAlertPopupClickAway;
  `)(openAlertPopupElement, mapStub, alertAreaOwners, activeAlertAreaOwner, null);

  const makeEvent = ({ insidePopup = false, alertArea = null } = {}) => ({
    target: {
      insidePopup,
      closest: selector => selector === '.wx-alert-area' ? alertArea : null
    },
    propagationStopped: false,
    stopPropagation() { this.propagationStopped = true; }
  });

  // With no popup, an area click must continue to Leaflet and open it normally.
  const initialAreaClick = makeEvent({ alertArea: activeAreaElement });
  clickAway(initialAreaClick);
  assert.equal(closeCount, 0);
  assert.equal(initialAreaClick.propagationStopped, false);

  activePopup = { contains: target => target.insidePopup };
  const insideClick = makeEvent({ insidePopup: true });
  clickAway(insideClick);
  assert.equal(closeCount, 0);

  const sameAreaClick = makeEvent({ alertArea: activeAreaElement });
  clickAway(sameAreaClick);
  assert.equal(closeCount, 1);
  assert.equal(sameAreaClick.propagationStopped, true);

  // One logical NWS alert can render as several SVG paths (for example, a
  // collection of county zones). Clicking any sibling path must still toggle it.
  const siblingAreaClick = makeEvent({ alertArea: siblingAreaElement });
  clickAway(siblingAreaClick);
  assert.equal(closeCount, 2);
  assert.equal(siblingAreaClick.propagationStopped, true);

  // A different area click must reach Leaflet, which atomically replaces the old
  // popup and anchors the new one at this click location.
  const differentAreaClick = makeEvent({ alertArea: differentAreaElement });
  clickAway(differentAreaClick);
  assert.equal(closeCount, 2);
  assert.equal(differentAreaClick.propagationStopped, false);

  const ordinaryClickAway = makeEvent();
  clickAway(ordinaryClickAway);
  assert.equal(closeCount, 3);
  assert.equal(ordinaryClickAway.propagationStopped, false);

  const handleEscape = new Function('openAlertPopupElement', 'map', `
    ${extractFunction('handleAlertPopupEscape')}
    return handleAlertPopupEscape;
  `)(openAlertPopupElement, mapStub);
  const keyEvent = key => ({ key, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
  handleEscape(keyEvent('Enter'));
  assert.equal(closeCount, 3);
  const consumed = keyEvent('Escape');
  handleEscape(consumed);
  assert.equal(closeCount, 4);
  // Closing the popup consumes the key, so pin mode's Escape handler skips it.
  assert.equal(consumed.defaultPrevented, true);
  activePopup = null;
  const unused = keyEvent('Escape');
  handleEscape(unused);
  assert.equal(closeCount, 4);
  assert.equal(unused.defaultPrevented, false);
  assert.match(html, /e\.key === 'Escape' && tapModeActive && !e\.defaultPrevented/);

  assert.match(html, /document\.addEventListener\('click', handleAlertPopupClickAway, \{ capture: true \}\)/);
  assert.match(html, /document\.addEventListener\('keydown', handleAlertPopupEscape\)/);
  const addGeometry = extractFunction('addAlertGeometryToMap');
  assert.match(addGeometry, /alertAreaOwners\.set\(areaElement, layer\)/);
  assert.match(addGeometry, /activeAlertAreaOwner = layer/);
  assert.match(addGeometry, /areaLayer\.on\('popupopen'/);
  assert.match(addGeometry, /areaLayer\.on\('popupclose'/);

  // Leaflet wraps a GeoJSON GeometryCollection in an intermediate FeatureGroup.
  // Every nested Path must be associated with the one logical alert owner.
  const firstAreaElement = {};
  const secondAreaElement = {};
  const tooltipBindings = [];
  const makeAreaPath = element => {
    const handlers = {};
    return {
      handlers,
      bindTooltip: () => { tooltipBindings.push(element); },
      getElement: () => element,
      on: (eventName, handler) => { handlers[eventName] = handler; }
    };
  };
  const firstAreaPath = makeAreaPath(firstAreaElement);
  const secondAreaPath = makeAreaPath(secondAreaElement);
  const nestedGeometryLayer = {
    eachLayer: visitor => [firstAreaPath, secondAreaPath].forEach(visitor)
  };
  const logicalAlertLayer = {
    bindPopup() {},
    eachLayer: visitor => visitor(nestedGeometryLayer)
  };
  const nestedAreaOwners = new WeakMap();
  const geometryHarness = new Function(
    'L', 'alertAreaGroup', 'alertAreaLayers', 'alertAreaOwners',
    'alertAreaPopupHtml', 'escapeHtml', 'restackAlertAreaLayers',
    'activeAlertAreaOwner', `
      ${addGeometry}
      return {
        addAlertGeometryToMap,
        getActiveOwner: () => activeAlertAreaOwner
      };
    `
  )(
    { geoJSON: () => logicalAlertLayer },
    { addLayer() {} },
    [],
    nestedAreaOwners,
    () => '',
    value => value,
    () => {},
    null
  );

  assert.doesNotThrow(() => geometryHarness.addAlertGeometryToMap(
    { type: 'GeometryCollection', geometries: [] }, {}, '#00d4ff', 'WATCH'
  ));
  assert.equal(nestedAreaOwners.get(firstAreaElement), logicalAlertLayer);
  assert.equal(nestedAreaOwners.get(secondAreaElement), logicalAlertLayer);
  assert.deepEqual(tooltipBindings, [firstAreaElement],
    'one logical alert should render one permanent label, not one per child zone');
  firstAreaPath.handlers.popupopen();
  assert.equal(geometryHarness.getActiveOwner(), logicalAlertLayer);
  firstAreaPath.handlers.popupclose();
  assert.equal(geometryHarness.getActiveOwner(), null);
});

test('watches rank below warnings even when the NWS rates them Extreme', () => {
  const alertClass = vm.runInNewContext(`(${extractFunction('alertClass')})`);
  // Live NWS data rates Tornado Watch "Extreme" and Flood Watch "Severe".
  assert.equal(alertClass({ event: 'Tornado Watch', severity: 'Extreme' }), 'watch');
  assert.equal(alertClass({ event: 'Flood Watch', severity: 'Severe' }), 'watch');
  assert.equal(alertClass({ event: 'Flood Warning', severity: 'Severe' }), 'warn');
  assert.equal(alertClass({ event: 'Tornado Warning', severity: 'Extreme' }), 'crit');
  assert.equal(alertClass({ event: 'Extreme Cold Statement', severity: 'Severe' }), 'warn');
  assert.equal(alertClass({ event: 'Wind Advisory', severity: 'Moderate' }), 'info');
});

test('alert areas stack smaller footprints on top and use danger to break area ties', () => {
  const factory = new Function(`
    const ALERT_CLASS_RANK = { crit: 0, warn: 1, watch: 2, info: 3 };
    const ALERT_SEV_WEIGHT = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3, Unknown: 4 };
    const ALERT_URGENCY_WEIGHT = { Immediate: 0, Expected: 1, Future: 2, Past: 3, Unknown: 4 };
    const ALERT_CERTAINTY_WEIGHT = { Observed: 0, Likely: 1, Possible: 2, Unlikely: 3, Unknown: 4 };
    ${extractFunction('alertClass')}
    ${extractFunction('compareAlertDanger')}
    ${extractFunction('alertGeometryArea')}
    const alertAreaSizes = new WeakMap();
    ${extractFunction('alertAreaSize')}
    ${extractFunction('compareAlertAreaStack')}
    return { alertGeometryArea, compareAlertAreaStack };
  `);
  const { alertGeometryArea, compareAlertAreaStack } = factory();
  const square = size => ({
    type: 'Polygon',
    coordinates: [[[0, 0], [size, 0], [size, size], [0, size], [0, 0]]]
  });
  const flashFloodWarning = {
    props: { event: 'Flash Flood Warning', severity: 'Severe' },
    geometry: square(10)
  };
  const floodWatch = {
    props: { event: 'Flood Watch', severity: 'Severe' },
    geometry: square(10)
  };
  assert.deepEqual(
    [flashFloodWarning, floodWatch].sort(compareAlertAreaStack),
    [floodWatch, flashFloodWarning],
    'danger priority must decide which equal-size footprint finishes on top'
  );

  const floodAdvisory = {
    props: { event: 'Flood Advisory', severity: 'Minor', urgency: 'Expected' },
    geometry: square(2)
  };
  assert.deepEqual(
    [floodAdvisory, floodWatch].sort(compareAlertAreaStack),
    [floodWatch, floodAdvisory],
    'the smaller advisory must remain clickable above a large watch'
  );

  const largeWarning = { props: { event: 'Flood Warning', severity: 'Severe' }, geometry: square(8) };
  const smallWarning = { props: { event: 'Flood Warning', severity: 'Severe' }, geometry: square(2) };
  assert.deepEqual(
    [smallWarning, largeWarning].sort(compareAlertAreaStack),
    [largeWarning, smallWarning],
    'smaller footprint must finish on top when danger priority is equal'
  );

  const futureWarning = {
    props: { event: 'Flood Warning', severity: 'Severe', urgency: 'Future' },
    geometry: square(8)
  };
  const immediateWarning = {
    props: { event: 'Flood Warning', severity: 'Severe', urgency: 'Immediate' },
    geometry: square(8)
  };
  assert.deepEqual(
    [immediateWarning, futureWarning].sort(compareAlertAreaStack),
    [futureWarning, immediateWarning],
    'greater urgency must decide which equal-size warning finishes on top'
  );

  const observedWarning = {
    props: { event: 'Flood Warning', severity: 'Severe', urgency: 'Immediate', certainty: 'Observed' },
    geometry: square(8)
  };
  const possibleWarning = {
    props: { event: 'Flood Warning', severity: 'Severe', urgency: 'Immediate', certainty: 'Possible' },
    geometry: square(8)
  };
  assert.deepEqual(
    [observedWarning, possibleWarning].sort(compareAlertAreaStack),
    [possibleWarning, observedWarning],
    'greater certainty must decide which otherwise-equal warning finishes on top'
  );

  const stableTieA = {
    props: { event: 'Coastal Flood Warning', severity: 'Severe', urgency: 'Immediate', certainty: 'Likely' },
    geometry: square(8)
  };
  const stableTieB = {
    props: { event: 'River Flood Warning', severity: 'Severe', urgency: 'Immediate', certainty: 'Likely' },
    geometry: square(8)
  };
  assert.notEqual(compareAlertAreaStack(stableTieA, stableTieB), 0,
    'equal-risk asynchronous layers need a stable final order');

  const polygonWithHole = {
    type: 'Polygon',
    coordinates: [square(10).coordinates[0], square(2).coordinates[0]]
  };
  assert.equal(alertGeometryArea(polygonWithHole), 96);

  const addGeometry = extractFunction('addAlertGeometryToMap');
  assert.match(addGeometry, /alertAreaLayers\.push/);
  assert.match(addGeometry, /restackAlertAreaLayers\(\)/);
});

test('nearby inline alert polygons are merged without adding unrelated regional alerts', () => {
  const factory = new Function(`
    ${extractFunction('alertGeometryBounds')}
    ${extractFunction('pointInPolygon')}
    ${extractFunction('alertPolygons')}
    ${extractFunction('pointInAlertPolygon')}
    ${extractFunction('geometryIntersectsBounds')}
    ${extractFunction('mergeVisibleAlerts')}
    return { alertGeometryBounds, geometryIntersectsBounds, mergeVisibleAlerts };
  `);
  const { alertGeometryBounds, geometryIntersectsBounds, mergeVisibleAlerts } = factory();
  const polygon = (west, south, east, north) => ({
    type: 'Polygon',
    coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]]
  });
  const viewport = { west: -98.8, south: 29.2, east: -98.1, north: 29.8 };
  const pointWatch = { id: 'watch', properties: { event: 'Flood Watch' }, geometry: null };
  const nearbyAdvisory = {
    id: 'advisory', properties: { event: 'Flood Advisory' },
    geometry: polygon(-98.6, 29.4, -98.3, 29.7)
  };
  const farWarning = {
    id: 'far', properties: { event: 'Tornado Warning' },
    geometry: polygon(-101, 31, -100.5, 31.5)
  };
  const regionalZoneOnly = {
    id: 'zone-only', properties: { event: 'Wind Advisory' }, geometry: null
  };

  assert.deepEqual(alertGeometryBounds(nearbyAdvisory.geometry), {
    west: -98.6, south: 29.4, east: -98.3, north: 29.7
  });
  assert.equal(geometryIntersectsBounds(nearbyAdvisory.geometry, viewport), true);
  assert.equal(geometryIntersectsBounds(farWarning.geometry, viewport), false);

  const triangleOutsideViewport = {
    type: 'Polygon',
    coordinates: [[[0, 0], [4, 0], [0, 4], [0, 0]]]
  };
  assert.equal(
    geometryIntersectsBounds(triangleOutsideViewport, { west: 3, south: 3, east: 4, north: 4 }),
    false,
    'overlapping bounding boxes must not include a polygon that misses the viewport'
  );

  const viewportInsideHole = {
    type: 'Polygon',
    coordinates: [
      [[-10, -10], [10, -10], [10, 10], [-10, 10], [-10, -10]],
      [[-2, -2], [2, -2], [2, 2], [-2, 2], [-2, -2]]
    ]
  };
  assert.equal(
    geometryIntersectsBounds(viewportInsideHole, { west: -1, south: -1, east: 1, north: 1 }),
    false,
    'a viewport entirely inside a polygon hole must not include that alert'
  );

  const thinCrossingPolygon = polygon(-2, -0.1, 2, 0.1);
  assert.equal(
    geometryIntersectsBounds(thinCrossingPolygon, { west: -0.5, south: -0.5, east: 0.5, north: 0.5 }),
    true,
    'edge crossings must count even when neither shape contains a vertex of the other'
  );
  assert.deepEqual(
    mergeVisibleAlerts(
      [pointWatch],
      [pointWatch, nearbyAdvisory, farWarning, regionalZoneOnly],
      viewport
    ).map(alert => alert.id),
    ['watch', 'advisory']
  );

  const fetchAlerts = extractFunction('fetchAlerts');
  assert.match(fetchAlerts, /fetchPointAlerts/);
  assert.match(fetchAlerts, /fetchAlertState/);
  assert.match(fetchAlerts, /fetchStateAlerts/);
  assert.match(fetchAlerts, /mergeVisibleAlerts/);
  assert.match(extractFunction('fetchStateAlerts'), /alerts\/active\?area=\$\{encodeURIComponent\(state\)\}/);
});

test('concurrent alert index lookups share one in-flight state request', async () => {
  let requestCount = 0;
  let resolveRequest;
  const pendingRequest = new Promise(resolve => { resolveRequest = resolve; });
  const harness = new Function('fetchJsonWithTimeout', `
    const stateAlertsCache = new Map();
    const stateAlertsRequests = new Map();
    const ALERTS_TTL_MS = 120000;
    const STATE_ALERTS_CACHE_LIMIT = 10;
    function setBoundedCache(cache, key, value) { cache.set(key, value); }
    ${extractFunction('isDisplayableAlert')}
    ${extractFunction('isAlertUnexpired')}
    async ${extractFunction('fetchStateAlerts')}
    return { fetchStateAlerts, pendingCount: () => stateAlertsRequests.size };
  `)(() => {
    requestCount++;
    return pendingRequest;
  });

  const first = harness.fetchStateAlerts('TX');
  const second = harness.fetchStateAlerts('TX');
  assert.equal(requestCount, 1);
  assert.equal(harness.pendingCount(), 1);

  const alert = { id: 'alert-1', properties: { event: 'Flood Advisory' } };
  resolveRequest({ response: { ok: true }, data: { features: [alert] } });
  assert.deepEqual(await first, [alert]);
  assert.deepEqual(await second, [alert]);
  assert.equal(harness.pendingCount(), 0);

  assert.match(html, /const pointAlertsRequests\s*= new Map\(\)/);
  assert.match(html, /const alertStateRequests\s*= new Map\(\)/);
});

test('alert feeds discard malformed feature entries at the network boundary', async () => {
  const validAlert = { id: 'valid', properties: { event: 'Flood Advisory' } };
  const harness = new Function('fetchJsonWithTimeout', `
    const pointAlertsCache = new Map();
    const pointAlertsRequests = new Map();
    const ALERTS_TTL_MS = 120000;
    const ALERTS_CACHE_LIMIT = 50;
    function setBoundedCache(cache, key, value) { cache.set(key, value); }
    ${extractFunction('isDisplayableAlert')}
    async ${extractFunction('fetchPointAlerts')}
    return { fetchPointAlerts };
  `)(async () => ({
    response: { ok: true, status: 200 },
    data: { features: [
      null, {}, { properties: null }, validAlert,
      // NWS test/exercise traffic must never be shown as a real alert.
      { id: 'test', properties: { event: 'Test Message', status: 'Test' } },
      { id: 'drill', properties: { event: 'Tornado Warning', status: 'Exercise' } }
    ] }
  }));

  assert.deepEqual(await harness.fetchPointAlerts(29.4, -98.5), [validAlert]);
});

test('cancelled alerts and border points are handled like the live NWS feed', () => {
  const isDisplayableAlert = vm.runInNewContext(`(${extractFunction('isDisplayableAlert')})`);
  // Real cancellation shape: still in /alerts/active, still named "Flood Watch".
  assert.equal(isDisplayableAlert({ properties: {
    event: 'Flood Watch', status: 'Actual', messageType: 'Alert', response: 'AllClear',
    urgency: 'Past', headline: 'The Flood Watch has been cancelled.' } }), false);
  assert.equal(isDisplayableAlert({ properties: { event: 'Tornado Warning', messageType: 'Cancel' } }), false);
  assert.equal(isDisplayableAlert({ properties: {
    event: 'Flood Watch', status: 'Actual', messageType: 'Update', response: 'Prepare' } }), true);

  // 42.0,-71.4 is in Rhode Island, but its nearest town is in Massachusetts.
  const pointStateCode = vm.runInNewContext(`(${extractFunction('pointStateCode')})`);
  assert.equal(pointStateCode({
    county: 'https://api.weather.gov/zones/county/RIC007',
    forecastZone: 'https://api.weather.gov/zones/forecast/RIZ001',
    relativeLocation: { properties: { state: 'MA' } } }), 'RI');
  assert.equal(pointStateCode({ relativeLocation: { properties: { state: 'TX' } } }), 'TX');
  assert.equal(pointStateCode({}), null);
});

test('a new area cancels zone lookups queued for the old one', async () => {
  const fetched = [];
  const harness = new Function('fetchJsonWithTimeout', `
    const zoneGeomCache = new Map();
    const ZONE_GEOM_CACHE_LIMIT = 200;
    const ZONE_FETCH_CONCURRENCY = 1;            // one at a time, so the rest queue
    const zoneFetchQueue = [];
    let zoneFetchActive = 0;
    function setBoundedCache(cache, key, value) { cache.set(key, value); }
    ${extractFunction('isTrustedNwsApiUrl')}
    ${extractFunction('drainZoneFetchQueue')}
    ${extractFunction('fetchZoneGeometry')}
    return { fetchZoneGeometry, cancelQueued: () => zoneFetchQueue.splice(0).forEach(t => t.cancel()),
             cached: url => zoneGeomCache.has(url) };
  `)(async url => { fetched.push(url); return { response: { ok: true }, data: { geometry: { type: 'Polygon' } } }; });

  const zone = n => `https://api.weather.gov/zones/forecast/Z${n}`;
  const first = harness.fetchZoneGeometry(zone(1));    // starts immediately
  const queued = harness.fetchZoneGeometry(zone(2));   // waits behind it
  harness.cancelQueued();
  assert.equal(await queued, undefined, 'a cancelled lookup resolves as a transient miss');
  assert.equal(harness.cached(zone(2)), false, 'and is not cached');
  await first;
  assert.deepEqual(fetched, [zone(1)]);
  assert.match(extractFunction('clearAlerts'), /zoneFetchQueue\.splice\(0\)\.forEach\(task => task\.cancel\(\)\)/);
});

test('alert cache expires before the next refresh tick', () => {
  // The cache clock starts when a fetch finishes, so a TTL equal to the refresh
  // interval would serve the previous result on every other tick.
  assert.match(html, /const ALERTS_TTL_MS = ALERTS_REFRESH_MS - 30 \* 1000;/);
  assert.match(extractFunction('loadAlertsForArea'), /setInterval\(refreshAlerts, ALERTS_REFRESH_MS\)/);
});

test('state-alert fallback is recent, unexpired, and limited to transient failures', async () => {
  let now = 200000;
  let responseStatus = 503;
  let responseFeatures = [];
  const activeAlert = { id: 'active', properties: { expires: new Date(300000).toISOString() } };
  const expiredAlert = { id: 'expired', properties: { expires: new Date(100000).toISOString() } };
  const staleAlerts = [activeAlert, expiredAlert];
  let requestCount = 0;
  const harness = new Function('fetchJsonWithTimeout', 'staleAlerts', 'Date', `
    const stateAlertsCache = new Map([['TX', { alerts: staleAlerts, ts: 1 }]]);
    const stateAlertsRequests = new Map();
    const ALERTS_TTL_MS = 120000;
    const STATE_ALERTS_STALE_MAX_MS = 1800000;
    const STATE_ALERTS_CACHE_LIMIT = 10;
    function setBoundedCache(cache, key, value) { cache.set(key, value); }
    ${extractFunction('isDisplayableAlert')}
    ${extractFunction('isAlertUnexpired')}
    async ${extractFunction('fetchStateAlerts')}
    return {
      fetchStateAlerts,
      cachedTimestamp: () => stateAlertsCache.get('TX').ts
    };
  `)(async () => {
    requestCount++;
    return {
      response: { ok: responseStatus === 200, status: responseStatus },
      data: { features: responseFeatures }
    };
  }, staleAlerts, { now: () => now, parse: Date.parse });

  const alerts = await harness.fetchStateAlerts('TX');
  assert.equal(requestCount, 1);
  assert.deepEqual(alerts, [activeAlert]);
  assert.equal(harness.cachedTimestamp(), 1,
    'stale data must remain expired so the next refresh retries the network');

  responseStatus = 404;
  assert.equal(await harness.fetchStateAlerts('TX'), null,
    'permanent client errors must not preserve an unverifiable regional feed');

  responseStatus = 503;
  now = 2000000;
  assert.equal(await harness.fetchStateAlerts('TX'), null,
    'even transient failures must not preserve regional data indefinitely');

  responseStatus = 200;
  responseFeatures = [null, {}, activeAlert];
  assert.deepEqual(await harness.fetchStateAlerts('TX'), [activeAlert],
    'successful state feeds must not cache malformed feature entries');
});

test('warning polygon containment excludes holes and non-warning products', () => {
  const factory = new Function(`
    ${extractFunction('pointInPolygon')}
    ${extractFunction('alertPolygons')}
    ${extractFunction('pointInAlertPolygon')}
    return { pointInAlertPolygon, alertPolygons };
  `);
  const { pointInAlertPolygon, alertPolygons } = factory();
  const outer = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
  const hole = [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]];
  assert.equal(pointInAlertPolygon(2, 2, [outer, hole]), true);
  assert.equal(pointInAlertPolygon(5, 5, [outer, hole]), false);
  assert.equal(pointInAlertPolygon(12, 5, [outer, hole]), false);
  assert.deepEqual(alertPolygons({ geometry: { type: 'Polygon', coordinates: [outer, hole] } }), [[outer, hole]]);

  const flagging = extractFunction('flagStationsInAlerts');
  assert.match(flagging, /event\.includes\('warning'\)/);
});

test('search URLs round-trip once-encoded and only after a successful lookup', () => {
  // Run the app's own pushQueryParam and read the URL back the way page load does.
  let written = '';
  const pushQueryParam = vm.runInNewContext(`(${extractFunction('pushQueryParam')})`, {
    URLSearchParams, String,
    parseCoords: raw => ({ lat: 1, lon: 2 }),
    window: { location: { pathname: '/app/' }, history: { replaceState: (_s, _t, url) => { written = url; } } }
  });
  for (const value of ['300 E Green St, Pasadena, CA', '50% + rain & snow', 'Montréal']) {
    pushQueryParam('address', value);
    assert.equal(new URLSearchParams(written.split('?')[1]).get('addr'), value);
  }
  assert.doesNotMatch(html, /decodeURIComponent\(params|safeDecodeParam/);

  // Only a search that loaded stations may replace the shareable link.
  const search = extractFunction('doSearch');
  assert.match(search, /if \(await loadStationsAt\(place\.lat, place\.lon, gen\)\) pushQueryParam\(type, raw\);/);
  assert.match(extractFunction('triggerPinSearch'),
    /loadStationsAt\(lat, lng, gen\)\.then\(loaded => \{\s*if \(loaded\) pushQueryParam\('coords', coordStr\);/);
  assert.equal((html.match(/pushQueryParam\(/g) || []).length, 3, 'definition + the two guarded calls only');
  // …and broken ?zip / ?lat links are rejected instead of becoming address searches.
  assert.match(html, /if \(detectInputType\(zipInput\.value\) === 'zip'\) doSearch\(\);/);
});

test('longitudes from a neighbouring world copy are wrapped before use', () => {
  // Leaflet reports e.g. 261.6 after panning sideways; Photon (400) and NOAA (404) reject it.
  assert.match(extractFunction('doSearch'), /map\.getCenter\(\)\.wrap\(\)/);
  assert.match(extractFunction('placeDragPin'), /\(\{ lat, lng \} = L\.latLng\(lat, lng\)\.wrap\(\)\);/);
  assert.match(extractFunction('showSearchPin'), /getLatLng\(\)\.wrap\(\)/);
  assert.match(extractFunction('fetchSuggestions'), /map\.getCenter\(\)\.wrap\(\)/);
});

test('station panel state survives junk input and overlapping requests', () => {
  // A cleared interval field keeps the current rate instead of the fastest one.
  assert.match(html, /Number\.isNaN\(parsed\) \? refreshInterval \/ 1000/);
  // Only the open panel's request may clear the "refreshing" pulse.
  assert.match(extractFunction('refreshStationData'),
    /finally \{[\s\S]*?if \(isActiveStation\(stationId, generation\)\) dotEl\.classList\.remove\('refreshing'\);/);
  assert.doesNotMatch(html, /stationRefreshActivityCount/);
});

test('address lookup uses key-less Photon and keeps only US matches', async () => {
  // The Geocodio key prompt is gone for good, and any stored key is wiped on startup.
  assert.doesNotMatch(html, /api\.geocod\.io|modal-api-key|ensureGeocodioApiKey/);
  assert.match(html, /localStorage\.removeItem\('wxmap_geocodio_key'\)/);

  const requested = [];
  let features = [];
  // extractFunction() starts at the `function` keyword, so restore `async`.
  const addressViaPhoton = vm.runInNewContext(`(async ${extractFunction('addressViaPhoton')})`, {
    encodeURIComponent,
    Number,
    fetchJsonWithTimeout: async url => {
      requested.push(url);
      return { response: { ok: true }, data: { features } };
    }
  });

  // A foreign candidate ranked first must be skipped in favour of the US one.
  features = [
    { properties: { countrycode: 'FR' }, geometry: { coordinates: [2.35, 48.85] } },
    { properties: { countrycode: 'US' }, geometry: { coordinates: [-95.55, 33.66] } }
  ];
  const near = { lat: 39.5, lon: -98.35 };
  assert.deepEqual({ ...await addressViaPhoton('paris tx', near) }, { lat: 33.66, lon: -95.55 });
  assert.match(requested[0], /^https:\/\/photon\.komoot\.io\/api\/\?q=paris%20tx&/);
  // Results are biased toward the map, or common names return no US match at all.
  // …but only coarsely (1 decimal, about 11 km): never the exact position.
  assert.match(requested[0], /&lat=39\.5&lon=-98\.[34]$/);

  features = [{ properties: { countrycode: 'FR' }, geometry: { coordinates: [2.35, 48.85] } }];
  assert.equal(await addressViaPhoton('paris', near), null);
});

test('house numbers go to Nominatim first, names to Photon first, each backed by the other', async () => {
  // Photon misses most US house numbers (and drops "6016 Enchantment … 78218"
  // entirely), while Nominatim has the Census ranges; Photon ranks names better.
  const make = ({ nominatim, photon }) => {
    const calls = [];
    const fn = new Function('fetchJsonWithTimeout', `
      ${html.match(/const HOUSE_NUMBER_RE = .*;/)[0]}
      async ${extractFunction('addressViaNominatim')}
      async ${extractFunction('addressViaPhoton')}
      async ${extractFunction('addressToCoords')}
      return addressToCoords;
    `)(async url => {
      const which = url.includes('nominatim') ? 'nominatim' : 'photon';
      calls.push({ which, url });
      const r = (which === 'nominatim' ? nominatim : photon)();
      return { response: { ok: r.ok !== false, status: r.status }, data: r.data };
    });
    return { fn, calls };
  };
  const house  = () => ({ data: [{ lat: '29.4938247', lon: '-98.3675119' }] });
  const street = () => ({ data: { features: [{ properties: { countrycode: 'US' }, geometry: { coordinates: [-98.37, 29.49] } }] } });
  const none   = { nominatim: () => ({ data: [] }), photon: () => ({ data: { features: [] } }) };
  const near   = { lat: 29.53, lon: -98.47 };

  // A house number: Nominatim's exact house, and Photon isn't asked at all.
  let s = make({ nominatim: house, photon: street });
  assert.deepEqual({ ...await s.fn('6016 Enchantment, San Antonio, Texas, 78218', near) },
    { lat: 29.4938247, lon: -98.3675119 });
  assert.deepEqual(s.calls.map(c => c.which), ['nominatim']);
  // US and territories only; the map bias is a coarse box, never the exact position.
  assert.match(s.calls[0].url, /&countrycodes=us,pr,vi,gu,as,mp&viewbox=-99\.5,30\.5,-97\.5,28\.5$/);

  // Nominatim ranks by fame: of its candidates, the one nearest the map wins
  // ("100 Main St" with the map on San Antonio: not Cambridge, MA). Bad rows are skipped.
  s = make({ nominatim: () => ({ data: [
    { lat: '42.36', lon: '-71.08' }, { lat: 'x', lon: '-98.4' }, { lat: '28.92', lon: '-98.55' },
    { lat: '29.70', lon: '-98.12' }] }), photon: street });
  assert.deepEqual({ ...await s.fn('100 Main St', near) }, { lat: 29.70, lon: -98.12 });
  assert.match(s.calls[0].url, /&limit=10&/);

  // A plain name: Photon first.
  s = make({ nominatim: house, photon: street });
  assert.deepEqual({ ...await s.fn('Enchantment, San Antonio', near) }, { lat: 29.49, lon: -98.37 });
  assert.deepEqual(s.calls.map(c => c.which), ['photon']);
  // "3rd Street" doesn't start with a house number; Queens' "37-12 75th St" does.
  s = make({ nominatim: house, photon: street });
  await s.fn('3rd Street, Austin', near);
  assert.deepEqual(s.calls.map(c => c.which), ['photon']);
  s = make({ nominatim: house, photon: street });
  await s.fn('37-12 75th St, Queens, NY', near);
  assert.deepEqual(s.calls.map(c => c.which), ['nominatim']);
  s = make({ nominatim: house, photon: street });
  await s.fn('37‐12 75th St, Queens, NY', near);   // a pasted typographic hyphen
  assert.deepEqual(s.calls.map(c => c.which), ['nominatim']);
  // Detroit's "8 Mile Rd" is a road name, not house 8 on "Mile Rd"…
  s = make({ nominatim: house, photon: street });
  await s.fn('8 Mile Rd, Detroit', near);
  assert.deepEqual(s.calls.map(c => c.which), ['photon']);
  for (const road of ['12 Mile Road', '7 Mile, Detroit', '8 Mile', '8 Mile Ro', '8 Mile R']) {
    s = make({ nominatim: house, photon: street });
    await s.fn(road, near);
    assert.deepEqual(s.calls.map(c => c.which), ['photon'], road);
  }
  // …but a house on it still counts, and so does one on a street merely
  // starting with "Mile".
  for (const home of ['1200 8 Mile Rd, Detroit', '45 Mile Creek Rd, Old Lyme, CT', '8 Miles Ave']) {
    s = make({ nominatim: house, photon: street });
    await s.fn(home, near);
    assert.deepEqual(s.calls.map(c => c.which), ['nominatim'], home);
  }

  // Nothing at the first, or the first unreachable: the other one answers.
  s = make({ nominatim: () => ({ data: [] }), photon: street });
  assert.deepEqual({ ...await s.fn('1109 n highlnd st arlington va', near) }, { lat: 29.49, lon: -98.37 });
  assert.deepEqual(s.calls.map(c => c.which), ['nominatim', 'photon']);
  s = make({ nominatim: () => ({ ok: false, status: 429 }), photon: street });
  assert.ok(await s.fn('5118 El Capitan St', near));

  // Neither finds it → "not found"; a failure that may have hidden it → that failure.
  await assert.rejects(make(none).fn('99999 Nowhere Rd', near), /not found/);
  await assert.rejects(make({ ...none, nominatim: () => ({ ok: false, status: 503 }) }).fn('1 Main St', near),
    /request failed/);
});

test('address suggestions: US places from Photon, with the typed house number kept', async () => {
  const feature = (properties, coordinates = [-98.37, 29.49]) =>
    ({ properties: { countrycode: 'US', ...properties }, geometry: { coordinates } });
  let features = [];
  const requested = [];
  const fetchSuggestions = new Function('fetchJsonWithTimeout', 'map', `
    ${html.match(/const HOUSE_NUMBER_RE = .*;/)[0]}
    ${html.match(/const SUGGEST_MIN_CHARS = \d+;/)[0]}
    ${html.match(/const SUGGEST_MAX\s+= \d+;/)[0]}
    ${html.match(/const SUGGEST_US_BBOX = '[^']+';/)[0]}
    ${extractFunction('suggestionFromFeature')}
    async ${extractFunction('fetchSuggestions')}
    return fetchSuggestions;
  `)(async url => { requested.push(url); return { response: { ok: true }, data: { features } }; },
     { getCenter: () => ({ wrap: () => ({ lat: 29.5312, lng: -98.4712 }) }) });

  features = [
    feature({ type: 'street', osm_key: 'highway', name: 'Enchantment', city: 'San Antonio', state: 'Texas', postcode: '78244' }),
    // Photon lists one street per piece of road: shown once.
    feature({ type: 'street', osm_key: 'highway', name: 'Enchantment', city: 'San Antonio', state: 'Texas', postcode: '78244' }),
    feature({ type: 'house', osm_key: 'highway', osm_value: 'bus_stop', name: 'Enchantment at Main' }),   // stop: noise
    feature({ type: 'street', name: 'Enchantment', countrycode: 'MX' }),                                   // not US
    feature({ type: 'house', osm_key: 'tourism', name: 'San Antonio Zoo', housenumber: '3903',
      street: "North Saint Mary's Street", city: 'San Antonio', state: 'Texas', postcode: '78212' }, [-98.47, 29.46]),
    feature({ type: 'city', osm_key: 'place', name: 'Boerne', state: 'Texas' }, [-98.73, 29.79])
  ];
  const list = await fetchSuggestions('6016 Ench');
  // The house number stays out of the request (it drowns Photon's street match);
  // the bias is coarse and the search box is the US.
  assert.match(requested[0], /\?q=Ench&limit=10&lang=en&lat=29\.5&lon=-98\.5&bbox=-180,15,-64,72$/);
  assert.deepEqual(list.map(s => s.text), [
    // Photon's postcode is for its piece of the street, not the house: left off.
    '6016 Enchantment, San Antonio, Texas',
    "San Antonio Zoo, 3903 North Saint Mary's Street, San Antonio, Texas 78212",
    'Boerne, Texas'
  ]);
  // The street still needs its house found (by the normal search); the rest are placed.
  assert.equal(list[0].place, null);
  assert.deepEqual({ ...list[1].place }, { lat: 29.46, lon: -98.47 });

  // "8 Mile" is the road's own name: the whole of it is asked for.
  features = [];
  await fetchSuggestions('8 Mile Rd');
  assert.match(requested.at(-1), /\?q=8%20Mile%20Rd&/);
  // Whether the 8 reads as a house number ("8 Mile Detroit") or not ("8 Mile Ro"),
  // the road is still the road — never "8 8 Mile Road" — while a house on it keeps
  // its own number.
  features = [feature({ type: 'street', name: '8 Mile Road', city: 'Detroit', state: 'Michigan', postcode: '48203' })];
  for (const typed of ['8 Mile Ro', '8 Mile Detroit']) {
    const [road] = await fetchSuggestions(typed);
    assert.equal(road.text, '8 Mile Road, Detroit, Michigan 48203', typed);
    assert.ok(road.place, typed);
  }
  // Half-typed, the road's whole name is asked for (so Photon finds 8 Mile, not 7 Mile)…
  await fetchSuggestions('8 Mile Ro');
  assert.match(requested.at(-1), /\?q=8%20Mile%20Ro&/);
  // …and OSM's "West 8 Mile Road" is that road too, not house 8 on it.
  features = [feature({ type: 'street', name: 'West 8 Mile Road', city: 'Ferndale', state: 'Michigan' })];
  const [west] = await fetchSuggestions('8 Mile Detroit');
  assert.equal(west.text, 'West 8 Mile Road, Ferndale, Michigan');
  assert.ok(west.place);
  features = [feature({ type: 'street', name: '8 Mile Road', city: 'Detroit', state: 'Michigan', postcode: '48203' })];
  const [onRoad] = await fetchSuggestions('1200 8 Mile');
  assert.equal(onRoad.text, '1200 8 Mile Road, Detroit, Michigan');
  assert.equal(onRoad.place, null);

  // Without a house number a street is placed directly; too little text asks nothing.
  features = [feature({ type: 'street', name: 'El Capitan Street', city: 'San Antonio', state: 'Texas' })];
  assert.equal((await fetchSuggestions('El Capitan'))[0].main, 'El Capitan Street');
  assert.ok((await fetchSuggestions('El Capitan'))[0].place);
  requested.length = 0;
  assert.deepEqual(await fetchSuggestions('12 El'), []);
  assert.equal(requested.length, 0);
});

test('address suggestions: wiring, keyboard and stale answers', () => {
  // A combobox: the list is announced and steered from the field.
  assert.match(html, /role="combobox"\s+aria-autocomplete="list"\s+aria-expanded="false"\s+aria-controls="addr-suggest"/);
  assert.match(html, /<ul id="addr-suggest" role="listbox"[^>]*hidden><\/ul>/);
  assert.match(extractFunction('renderSuggestions'), /aria-activedescendant/);
  // Only addresses ask, after a pause; a newer keystroke, search or blur drops the answer.
  const onInput = html.slice(html.indexOf("zipInput.addEventListener('input'"));
  assert.match(onInput, /if \(detectInputType\(text\) !== 'address'\) \{ closeSuggestions\(\); return; \}/);
  assert.match(onInput, /if \(request !== suggestRequest \|\| document\.activeElement !== zipInput\) return;/);
  assert.match(extractFunction('closeSuggestions'), /clearTimeout\(suggestTimer\);\s*suggestTimer = 0;\s*suggestRequest\+\+;/);
  assert.match(extractFunction('doSearch'), /^function doSearch\(knownPlace\) \{\s*\/\/.*\s*closeSuggestions\(\);/);
  assert.match(html, /zipInput\.addEventListener\('blur', closeSuggestions\);/);
  // A click on a row lands before the field loses focus.
  assert.match(html, /suggestList\.addEventListener\('mousedown', e => e\.preventDefault\(\)\);/);
  // FIND must not hand its click event to doSearch as a place.
  assert.match(html, /searchBtn\.addEventListener\('click', \(\) => doSearch\(\)\);/);
  // Enter picks the highlighted row, else searches the text as typed.
  assert.match(html, /if \(suggestActive >= 0\) pickSuggestion\(suggestActive\);\s*else doSearch\(\);/);
  // A fresh answer drops a highlight moved through the old list meanwhile (it would
  // point past the new rows: a crash in renderSuggestions, and Enter doing nothing).
  assert.match(onInput, /suggestTimer = 0;[^\n]*\s*suggestions = list;[\s\S]{0,200}?suggestActive = -1;\s*renderSuggestions\(\);/);
  // Esc also stops a lookup that hasn't shown its list yet; a closed list leaves none pending.
  assert.match(html, /\} else if \(e\.key === 'Escape' && \(!suggestList\.hidden \|\| suggestTimer\)\) \{/);
  // A pin or Locate Me search replaces the field's text, so it closes the list too.
  assert.match(extractFunction('triggerPinSearch'), /closeSuggestions\(\);\s*zipInput\.value = coordStr;/);

  // Arrow keys cycle through the rows and back to "none" at either end.
  const move = vm.runInNewContext(`(() => {
    let suggestions = [1, 2, 3], suggestActive = -1;
    const renderSuggestions = () => {};
    ${extractFunction('moveSuggestionHighlight')}
    return step => { moveSuggestionHighlight(step); return suggestActive; };
  })()`);
  assert.deepEqual([1, 1, 1, 1, 1].map(step => move(step)), [0, 1, 2, -1, 0]);
  assert.deepEqual([-1, -1, -1].map(step => move(step)), [-1, 2, 1]);

  // The list hangs over the map: the header rises above the banners only while it's open.
  assert.match(html, /header:has\(#addr-suggest:not\(\[hidden\]\)\) \{ z-index: 1160; \}/);
});

test('address suggestions: a typing session, run for real', async () => {
  // The real input handler, closeSuggestions and arrow-key code, with the network
  // and the typing-pause timer under the test's control.
  const handlers = {};
  const zipInput = { value: '', addEventListener: (type, fn) => { handlers[type] = fn; } };
  const timers = new Map();
  let timerId = 0;
  const pending = [];   // suggestion requests still on their way: { text, answer }
  const ctx = vm.createContext({
    zipInput,
    suggestList: { hidden: true },
    document: { activeElement: zipInput },
    detectInputType: text => (/^\d{5}$/.test(text) ? 'zip' : 'address'),
    fetchSuggestions: text => new Promise(answer => pending.push({ text, answer })),
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: id => timers.delete(id)
  });
  const start = html.indexOf("zipInput.addEventListener('input'");
  vm.runInContext(`
    ${html.match(/const SUGGEST_DELAY_MS\s+= \d+;/)[0]}
    let suggestTimer = 0, suggestRequest = 0, suggestions = [], suggestActive = -1;
    function renderSuggestions() { suggestList.hidden = !suggestions.length; }
    ${extractFunction('closeSuggestions')}
    ${extractFunction('moveSuggestionHighlight')}
    ${html.slice(start, html.indexOf("zipInput.addEventListener('blur'", start))}
    this.state = () => ({ pending: suggestTimer !== 0, rows: suggestions.length, active: suggestActive });
    this.move = moveSuggestionHighlight;
    this.blur = closeSuggestions;
  `, ctx);
  const type = text => { zipInput.value = text; handlers.input(); };
  // The typing pause ends: its request goes out (and waits in `pending`).
  const pause = () => { const [id, fn] = [...timers][timers.size - 1]; timers.delete(id); return fn(); };
  // A copy made here: objects from the vm context fail deepEqual's prototype check.
  const state = () => ({ ...ctx.state() });
  const rows = n => Array.from({ length: n }, (_, i) => ({ text: 'row ' + i }));

  type('Main');
  assert.equal(state().pending, true, 'a lookup waits for the typing pause');
  let done = pause();
  pending.shift().answer(rows(6));
  await done;
  assert.deepEqual(state(), { pending: false, rows: 6, active: -1 });

  // Typing on keeps the old list up; arrows move through it while the next loads.
  type('Main S');
  ctx.move(1); ctx.move(1); ctx.move(1);
  assert.equal(state().active, 2);
  done = pause();
  pending.shift().answer(rows(2));
  await done;
  assert.deepEqual(state(), { pending: false, rows: 2, active: -1 }, 'the old highlight must not survive');

  // An answer overtaken by newer typing is ignored; the newer lookup stays pending.
  type('Main St');
  const older = pause();
  type('Main Str');
  pending.shift().answer(rows(5));
  await older;
  assert.deepEqual(state(), { pending: true, rows: 2, active: -1 });
  done = pause();
  pending.shift().answer(rows(3));
  await done;
  assert.deepEqual(state(), { pending: false, rows: 3, active: -1 });

  // Leaving the field mid-lookup: the late answer never opens the list.
  type('Elm');
  done = pause();
  ctx.blur();
  pending.shift().answer(rows(4));
  await done;
  assert.deepEqual(state(), { pending: false, rows: 0, active: -1 });

  // Focus moved away without a blur reaching the field: the answer is still dropped.
  type('Oak');
  done = pause();
  ctx.document.activeElement = {};
  pending.shift().answer(rows(4));
  await done;
  assert.equal(state().rows, 0);
  ctx.document.activeElement = zipInput;

  // Turning the text into a ZIP cancels the lookup waiting for its pause, and
  // leaves nothing pending (so Esc isn't held back).
  type('Pine');
  assert.equal(state().pending, true);
  type('78218');
  assert.deepEqual(state(), { pending: false, rows: 0, active: -1 });
  assert.equal(timers.size, 0);
});

test('a found address is marked with the search pin', () => {
  const search = extractFunction('doSearch');
  assert.match(search, /if \(type === 'address'\) showSearchPin\(place\.lat, place\.lon\);\s*else removeDragPin\(\);/);
  // A picked suggestion that is already placed skips the second lookup, but still
  // shows the loading overlay like every other search.
  assert.match(search, /\} else if \(knownPlace\) \{[\s\S]{0,200}?showOverlay\([^)]*\);\s*place = knownPlace;/);
});

test('station panel shows readings promptly and formats them cleanly', () => {
  const toFixedClean = vm.runInNewContext(
    html.match(/const toFixedClean = (\(n, digits\) => \{[\s\S]*?\n\});/)[1]);
  assert.equal(toFixedClean(-0.04, 1), '0.0', 'tiny negatives must not render as "-0.0"');
  assert.equal(toFixedClean(-1.25, 1), '-1.3');

  // The (slow, separate) forecast lookup is not awaited by the refresh itself — see
  // the behavioural test 'a slow rain-chance lookup never holds up the next refresh'.
  assert.doesNotMatch(extractFunction('refreshStationData'), /await fetchForecastPoP/);
  assert.match(html, /const FORECAST_FAILURE_TTL_MS = 2 \* 60 \* 1000;/);

  // The refresh interval is clamped so setInterval can't overflow into a tight loop.
  assert.match(html, /id="interval-input"[\s\S]*?max="3600"/);
  assert.match(html, /const MAX_REFRESH_SECONDS = 3600;/);

  // Malformed station entries are skipped instead of aborting the whole plot.
  assert.match(extractFunction('plotStations'), /Number\.isFinite\(la\) && Number\.isFinite\(lng\)/);
});

test('every search path allocates or receives a generation before awaiting', () => {
  const search = extractFunction('doSearch');
  assert.ok(search.indexOf('const gen = ++searchGeneration') < search.indexOf('await zipToCoords'));
  assert.match(search, /loadStationsAt\(place\.lat, place\.lon, gen\)/);
  assert.match(search, /catch \(e\) \{\s*if \(gen !== searchGeneration\) return;/);

  // loadStationsAt never allocates its own generation: every caller passes one.
  const stationLoader = extractFunction('loadStationsAt');
  assert.match(stationLoader, /^function loadStationsAt\(lat, lon, gen\)/);
  assert.match(stationLoader, /const area = \+\+areaGeneration;/);
  assert.match(stationLoader, /if \(area !== areaGeneration\) return false;/);
  assert.match(stationLoader, /if \(mayUpdateSearchUi\(gen\)\) \{\s*settledSearch = searchGeneration;\s*setStatus\(/);
  assert.doesNotMatch(html, /loadStationsAt\(\s*\w+\s*,\s*\w+\s*\)/,
    'every call site must pass its pre-allocated generation');

  const locateHandler = html.slice(html.indexOf("fabLocate.addEventListener('click'"));
  assert.ok(locateHandler.indexOf('const gen = ++searchGeneration') <
    locateHandler.indexOf('navigator.geolocation.getCurrentPosition'));
  // Every outcome (success, error, or the watchdog for a prompt that never answers)
  // releases the button first, then honours a newer search.
  assert.match(locateHandler, /function settle\(\) \{[\s\S]*?fabLocate\.removeAttribute\('aria-disabled'\);/);
  // A late success is still used (unless superseded); a late error is not re-reported.
  assert.match(locateHandler, /settle\(\);\s*if \(gen !== searchGeneration\) return;/);
  assert.match(locateHandler, /err => \{\s*if \(!settle\(\)\) return;\s*if \(gen !== searchGeneration\) return;/);
  assert.match(locateHandler, /const watchdog = setTimeout\(\(\) => \{\s*if \(!settle\(\) \|\| gen !== searchGeneration\) return;/);
});

test('a station that never reports says so and is not polled; the old time is cleared', async () => {
  // Runs the real panel code with a fake page, live timers and a scripted feed.
  function makePanel(fetchObservations, hidden = false) {
    const elements = {};
    const classSet = () => { const s = new Set(); return { add: (...c) => c.forEach(x => s.add(x)), remove: (...c) => c.forEach(x => s.delete(x)),
      toggle: (c, on) => (on ? s.add(c) : s.delete(c)), contains: c => s.has(c) }; };
    const el = id => (elements[id] ||= { textContent: 'OBS: 05:15 AM CDT', innerHTML: '', style: {}, classList: classSet(),
      // The loading skeleton is the only thing querySelector needs to find.
      querySelector(sel) { return sel === '.station-loading' && this.innerHTML.includes('station-loading') ? {} : null; } });
    const doc = { hidden, getElementById: el };
    const live = new Set();
    let nextTimer = 1;
    const panel = vm.runInNewContext(`(() => {
      let refreshTimer = null, activeMarkerEl = null, stationOpenGeneration = 0, activeStationId = null,
          activeStationName = null, stationRefreshRequest = null, stationRefreshMissed = false,
          stationNoDataGeneration = 0, refreshInterval = 60000;
      ${escapeHtmlSource}
      ${extractFunction('isActiveStation')}
      async ${extractFunction('refreshStationData')}
      async ${extractFunction('doStationRefresh')}
      async ${extractFunction('openStation')}
      // What the visibilitychange catch-up does once the tab is shown again.
      const tick = () => doStationRefresh(activeStationId, stationOpenGeneration);
      return { openStation, tick };
    })()`, {
      document: doc, popupPanel: { style: {} }, forecastPoPCache: new Map(), fetchObservations,
      setInterval: () => { live.add(nextTimer); return nextTimer++; }, clearInterval: id => live.delete(id),
      renderWeather: () => { el('popup-body').innerHTML = 'readings'; el('update-time').textContent = 'OBS: now'; }
    });
    el('update-time');   // the previous station's time is showing
    return { ...panel, elements, doc, live };
  }
  const notFound = id => Object.assign(new Error(`Station "${id}" not found or has no recent observations`), { status: 404 });

  // Visible tab: the 404 is shown (not "retrying…") and no timer is started.
  let p = makePanel(async id => {
    assert.equal(p.elements['update-time'].textContent, '—', 'old time cleared before the request');
    throw notFound(id);
  });
  await p.openStation('PAJC', 'Test', null);
  assert.match(p.elements['popup-body'].innerHTML, /not found or has no recent observations/);
  assert.doesNotMatch(p.elements['popup-body'].innerHTML, /retrying/);
  assert.equal(p.live.size, 0, 'a permanent 404 must not be polled');
  assert.equal(p.elements['update-indicator'].style.display, 'none', 'no "LIVE · N s" for a station that is not polled');

  // Hidden tab: the timer starts before the first fetch; the catch-up 404 stops it.
  p = makePanel(async id => { throw notFound(id); }, true);
  await p.openStation('PAJC', 'Test', null);
  assert.equal(p.live.size, 1);
  p.doc.hidden = false;
  await p.tick();
  assert.equal(p.live.size, 0);

  // A passing outage on first load still says "retrying…" and keeps polling.
  p = makePanel(async () => { throw new Error('NOAA observations API returned HTTP 500'); });
  await p.openStation('KORD', 'Test', null);
  assert.match(p.elements['popup-body'].innerHTML, /retrying/);
  assert.equal(p.live.size, 1);

  // A 404 after data has shown is a failed refresh: data kept, error flagged, still polled.
  let calls = 0;
  p = makePanel(async id => { if (calls++) throw notFound(id); return {}; });
  await p.openStation('KORD', 'Test', null);
  await p.tick();
  assert.equal(p.elements['popup-body'].innerHTML, 'readings');
  // The shown reading keeps its time (and so its age); the dot turns red.
  assert.equal(p.elements['update-time'].textContent, 'OBS: now · update failed');
  assert.ok(p.elements['update-dot'].classList.contains('stale'));
  await p.tick();   // a second failure doesn't repeat the note
  assert.equal(p.elements['update-time'].textContent, 'OBS: now · update failed');
  assert.equal(p.live.size, 1);

  // The next good refresh clears the red dot and the note.
  calls = 0;
  p = makePanel(async () => { if (++calls === 2) throw new Error('NOAA observations API returned HTTP 500'); return {}; });
  await p.openStation('KORD', 'Test', null);
  await p.tick();
  assert.ok(p.elements['update-dot'].classList.contains('stale'));
  await p.tick();
  assert.ok(!p.elements['update-dot'].classList.contains('stale'));
  assert.equal(p.elements['update-time'].textContent, 'OBS: now');

  // Opening another station after a no-data one shows the LIVE interval again.
  calls = 0;
  p = makePanel(async id => { if (++calls === 1) throw notFound(id); return {}; });
  await p.openStation('PAJC', 'Test', null);
  assert.equal(p.elements['update-indicator'].style.display, 'none');
  await p.openStation('KORD', 'Test', null);
  assert.equal(p.elements['update-indicator'].style.display, '');
});

test('station refreshes bind to one panel lifetime and zone fetches share a global limit', () => {
  const refresh = extractFunction('doStationRefresh');
  assert.match(refresh, /isActiveStation\(stationId, generation\)/);
  assert.match(refresh, /stationRefreshRequest\.generation === generation/);
  assert.match(extractFunction('openStation'), /const generation = \+\+stationOpenGeneration/);

  const zoneFetch = extractFunction('fetchZoneGeometry');
  assert.match(zoneFetch, /zoneFetchQueue\.unshift/);
  assert.match(extractFunction('drainZoneFetchQueue'), /zoneFetchActive < ZONE_FETCH_CONCURRENCY/);
  assert.doesNotMatch(html, /function mapWithConcurrency/);
});

test('zone geometry caches permanent absence but retries transient failures', async () => {
  const requestCounts = new Map();
  const fetchJsonWithTimeout = async url => {
    requestCounts.set(url, (requestCounts.get(url) || 0) + 1);
    if (url.endsWith('/missing')) {
      return { response: { ok: false, status: 404 }, data: {} };
    }
    if (url.endsWith('/busy')) {
      return { response: { ok: false, status: 503 }, data: {} };
    }
    return {
      response: { ok: true, status: 200 },
      data: { geometry: { type: 'Polygon', coordinates: [] } }
    };
  };
  const zoneHarness = new Function('fetchJsonWithTimeout', `
    const zoneGeomCache = new Map();
    const ZONE_GEOM_CACHE_LIMIT = 200;
    const ZONE_FETCH_CONCURRENCY = 6;
    const zoneFetchQueue = [];
    let zoneFetchActive = 0;
    function setBoundedCache(cache, key, value) { cache.set(key, value); }
    ${extractFunction('isTrustedNwsApiUrl')}
    ${extractFunction('drainZoneFetchQueue')}
    ${extractFunction('fetchZoneGeometry')}
    return { fetchZoneGeometry };
  `)(fetchJsonWithTimeout);

  const missingUrl = 'https://api.weather.gov/zones/forecast/missing';
  assert.equal(await zoneHarness.fetchZoneGeometry(missingUrl), null);
  assert.equal(await zoneHarness.fetchZoneGeometry(missingUrl), null);
  assert.equal(requestCounts.get(missingUrl), 1, 'permanent absence should stay cached');

  const busyUrl = 'https://api.weather.gov/zones/forecast/busy';
  assert.equal(await zoneHarness.fetchZoneGeometry(busyUrl), undefined);
  assert.equal(await zoneHarness.fetchZoneGeometry(busyUrl), undefined);
  assert.equal(requestCounts.get(busyUrl), 2, 'transient failures should be retried');

  const blockedUrl = 'http://127.0.0.1/zones/private';
  assert.equal(await zoneHarness.fetchZoneGeometry(blockedUrl), null);
  assert.equal(requestCounts.has(blockedUrl), false, 'untrusted zone origins must never be fetched');
});

test('only transient zone geometry failures are retried without resetting an unchanged alert banner', async () => {
  const drawnGeometries = [];
  const renderHarness = new Function('fetchZoneGeometry', 'addAlertGeometryToMap', `
    let alertAreaSeq = 0;
    let alertAreasNeedRetry = false;
    function clearAlertAreas() { alertAreaSeq++; }
    function alertHue() { return 0; }
    function shortAlertLabel() { return 'WATCH'; }
    ${extractFunction('drawAlertArea')}
    ${extractFunction('renderAlertAreas')}
    return {
      renderAlertAreas,
      needsRetry: () => alertAreasNeedRetry
    };
  `)(
    url => Promise.resolve(
      url.endsWith('/good') ? { type: 'Polygon', coordinates: [] } :
        url.endsWith('/retry') ? undefined : null
    ),
    geometry => { drawnGeometries.push(geometry); }
  );

  renderHarness.renderAlertAreas([{
    id: 'watch-1',
    properties: {
      event: 'Flood Watch',
      affectedZones: ['https://example.test/good', 'https://example.test/retry']
    },
    geometry: null
  }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(renderHarness.needsRetry(), true);
  assert.equal(drawnGeometries[0].geometries.length, 1);

  // A permanent 4xx/no-geometry result is intentionally cached as null. It should
  // not force a redraw on every refresh because another request cannot repair it.
  renderHarness.renderAlertAreas([{
    id: 'watch-1',
    properties: {
      event: 'Flood Watch',
      affectedZones: ['https://example.test/good', 'https://example.test/permanent']
    },
    geometry: null
  }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(renderHarness.needsRetry(), false);
  assert.equal(drawnGeometries[1].geometries.length, 1);

  const refreshHarness = new Function('alerts', `
    let currentLat = 1;
    let currentLon = 2;
    let lastAlertSignature = 'unchanged';
    let alertAreasNeedRetry = true;
    let areaRenderCount = 0;
    async function fetchAlerts() { return alerts; }
    function alertsSignature() { return 'unchanged'; }
    function renderAlertAreas() { areaRenderCount++; }
    let activeAlertAreaOwner = null;
    let shownAlerts = [];
    ${extractFunction('showAlerts')}
    let currentViewport = null;
    const document = { hidden: false };
    async ${extractFunction('refreshAlerts')}
    return { refreshAlerts, areaRenderCount: () => areaRenderCount,
             openPopup: () => { activeAlertAreaOwner = {}; } };
  `)([{ id: 'watch-1' }]);

  await refreshHarness.refreshAlerts();
  assert.equal(refreshHarness.areaRenderCount(), 1);
  // While the user has an area popup open, the retry waits (a redraw would close it).
  refreshHarness.openPopup();
  await refreshHarness.refreshAlerts();
  assert.equal(refreshHarness.areaRenderCount(), 1);
});

test('a first alert load is dropped only when its area is replaced', async () => {
  let resolveFetch;
  const shown = [];
  let timers = 0;
  const harness = new Function('fetchAlerts', 'showAlerts', `
    let alertLoadToken = null, currentLat = null, currentLon = null, alertsTimer = null;
    const ALERTS_REFRESH_MS = 1;
    const console = { error() {} };
    function refreshAlerts() {}
    function clearInterval() {}
    function setInterval() { return ++globalThis.__timers; }
    let currentViewport = null;
    function alertViewportBounds() { return null; }
    async ${extractFunction('loadAlertsForArea')}
    return { loadAlertsForArea, replaceArea: () => { alertLoadToken = null; } };
  `)(() => new Promise(resolve => { resolveFetch = resolve; }), alerts => shown.push(alerts));
  globalThis.__timers = 0;

  // A later search that fails before loading stations never touches the token,
  // so the area still on screen must get its alerts and refresh loop.
  const kept = harness.loadAlertsForArea(1, 2);
  resolveFetch([{ id: 'kept' }]);
  await kept;
  assert.deepEqual(shown, [[{ id: 'kept' }]]);
  timers = globalThis.__timers;
  assert.equal(timers, 1);

  // A newer area (clearAlerts) invalidates the in-flight load: nothing is drawn.
  const dropped = harness.loadAlertsForArea(3, 4);
  harness.replaceArea();
  resolveFetch([{ id: 'stale' }]);
  await dropped;
  assert.equal(shown.length, 1);
  assert.equal(globalThis.__timers, timers, 'a replaced load must not start a refresh loop');
  delete globalThis.__timers;
});

test('a feed outage drops alerts whose hazard has ended', async () => {
  const redrawn = [];
  const past = new Date(Date.now() - 60_000).toISOString();
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const harness = new Function('showAlerts', 'initial', `
    let currentLat = 1, currentLon = 2, lastAlertSignature = 'x';
    let alertAreasNeedRetry = false, activeAlertAreaOwner = null;
    let shownAlerts = initial;
    const console = { error() {} };
    async function fetchAlerts() { return null; }   // feed unreachable
    ${extractFunction('isAlertUnexpired')}
    let currentViewport = null;
    const document = { hidden: false };
    async ${extractFunction('refreshAlerts')}
    return { refreshAlerts };
  `)(alerts => redrawn.push(alerts), [
    { id: 'ended', properties: { ends: past } },
    { id: 'active', properties: { ends: future } }
  ]);

  await harness.refreshAlerts();
  assert.deepEqual(redrawn.map(list => list.map(f => f.id)), [['active']]);
});

test('alert refresh commits its signature only after rendering succeeds', async () => {
  const refreshHarness = new Function('alerts', `
    let currentLat = 1;
    let currentLon = 2;
    let lastAlertSignature = 'old';
    let alertAreasNeedRetry = false;
    async function fetchAlerts() { return alerts; }
    function alertsSignature() { return 'new'; }
    function renderAlertBanner() { throw new Error('malformed alert'); }
    function flagStationsInAlerts() {}
    function renderAlertAreas() {}
    const console = { error() {} };
    let shownAlerts = [];
    let activeAlertAreaOwner = null;
    ${extractFunction('isAlertUnexpired')}
    ${extractFunction('showAlerts')}
    let currentViewport = null;
    const document = { hidden: false };
    async ${extractFunction('refreshAlerts')}
    return { refreshAlerts, signature: () => lastAlertSignature };
  `)([{ id: 'watch-1' }]);

  await refreshHarness.refreshAlerts();
  assert.equal(refreshHarness.signature(), 'old');
});

test('dismissing an update cannot schedule an automatic reload', () => {
  const updateHandler = html.slice(
    html.indexOf("window.addEventListener('wx-app-update-ready'"),
    html.indexOf("window.addEventListener('appinstalled'")
  );
  assert.match(updateHandler, /dismissBtn\.onclick/);
  assert.doesNotMatch(updateHandler, /setTimeout|auto-applying|display-mode: standalone/);
});

// timeout: a backtracking regex would hang the suite instead of failing it.
test('search input classification: ZIP+4 without hyphen, and mistyped ZIPs are not addresses', { timeout: 5000 }, () => {
  const detect = vm.runInNewContext(`(() => { ${extractFunction('normalizeSearchText')} ${extractFunction('detectInputType')} return detectInputType; })()`);
  assert.equal(detect('78201'), 'zip');
  assert.equal(detect('90210-1234'), 'zip');
  assert.equal(detect(' 902101234 '), 'zip');
  assert.equal(detect('78201 1234'), 'zip');
  // "7820" as an address matches some house number far away — reject it instead.
  assert.equal(detect('7820'), 'badzip');
  assert.equal(detect('782011'), 'badzip');
  assert.equal(detect('123-45-6789'), 'badzip');
  // Coordinates typed with a space instead of a comma are coordinates (as an
  // address, "29.42 -98.49" matched a street in Tacoma, WA).
  assert.equal(detect('29.42 -98.49'), 'coords');
  assert.equal(detect('29 -98'), 'coords');
  assert.equal(detect('29.42-98.49'), 'badzip');
  // A mistyped ZIP+4 is not a coordinate pair; signed / dot-first numbers are.
  assert.equal(detect('78201 123'), 'badzip');
  assert.equal(detect('7820 1234'), 'badzip');
  assert.equal(detect('+29.4 -98.5'), 'coords');
  assert.equal(detect('.5 .5'), 'coords');
  assert.equal(detect('29., -98.'), 'coords');
  assert.equal(detect('0029.4, -98.5'), 'coords');      // leading zeros, as before
  assert.equal(detect('29.42 −98.49'), 'coords');  // pasted Unicode minus
  assert.equal(detect('29.42, –98.49'), 'coords'); // en dash
  // Degree-style coordinates went to Photon and loaded Tacoma, WA: reject instead.
  assert.equal(detect('29.42°N 98.49°W'), 'badzip');
  assert.equal(detect('29.42 N, 98.49 W'), 'badzip');
  assert.equal(detect('news'), 'address');            // N/S/E/W letters need a digit
  // Utah-style grid addresses are real addresses, not coordinates.
  assert.equal(detect('200 S 300 E'), 'address');
  assert.equal(detect('350 S 200 E'), 'address');
  assert.equal(detect('2100 E'), 'address');
  // A 0-leading ZIP typo is a ZIP problem, not "invalid coordinates".
  assert.equal(detect('00601 12'), 'badzip');
  assert.equal(detect('00601'), 'zip');
  assert.equal(detect('02138 Cambridge MA'), 'address');   // ZIP + city is an address
  assert.equal(detect('02138, MA'), 'address');
  // Copied tuples / arrays are coordinates, not an address that lands in Tacoma.
  assert.equal(detect('(29.42, -98.49)'), 'coords');
  assert.equal(detect('[29.42, -98.49]'), 'coords');
  assert.equal(detect('( 29.42 , -98.49 )'), 'coords');
  // Half-copied brackets or a ";" separator: rejected, not geocoded to Tacoma.
  assert.equal(detect('(29.42, -98.49'), 'badzip');
  assert.equal(detect('29.42;-98.49'), 'badzip');
  for (const t of ['29.42/-98.49', '29.42:-98.49', '{29.42, -98.49}']) assert.equal(detect(t), 'badzip', t);
  for (const a of ['1/2 Main St', '24/7 Market', '4-H Club Rd']) assert.equal(detect(a), 'address', a);
  // Whole-degree coordinates with glued letters; spaced grid addresses stay.
  assert.equal(detect('29N 98W'), 'badzip');
  assert.equal(detect('N29 W98'), 'badzip');
  for (const a of ['1300 S', '33 W', '10 S 5 E', '100 N 200 W', '78201 San Antonio TX']) {
    assert.equal(detect(a), 'address', a);
  }
  assert.equal(detect('(78201)'), 'zip');
  assert.equal(detect('00029.4, -98.5'), 'coords');
  // Linear time: a crafted deep link with a huge bracketed input must not hang.
  const norm = vm.runInNewContext(`(() => { ${extractFunction('normalizeSearchText')} return normalizeSearchText; })()`);
  const t0 = Date.now();
  norm('(' + ' '.repeat(30000));
  assert.ok(Date.now() - t0 < 200, 'normalizeSearchText must not backtrack');
  assert.match(extractFunction('doSearch'), /zipToCoords\(normalizeSearchText\(raw\)\)/);
  // Non-breaking hyphen pasted from Word/Docs works as a minus.
  assert.equal(detect('29.42 ‑98.49'), 'coords');
  const parse = vm.runInNewContext(`(() => { ${extractFunction('normalizeSearchText')} ${extractFunction('parseCoords')} return parseCoords; })()`);
  assert.deepEqual({ ...parse(' 29.42   -98.49 ') }, { lat: 29.42, lon: -98.49 });
  assert.deepEqual({ ...parse('29.42 , -98.49') }, { lat: 29.42, lon: -98.49 });
  assert.deepEqual({ ...parse('[29.42, -98.49]') }, { lat: 29.42, lon: -98.49 });
  assert.deepEqual({ ...parse('29.42 −98.49') }, { lat: 29.42, lon: -98.49 });
  assert.equal(detect('29.4, -98.5'), 'coords');
  assert.equal(detect('1600 Pennsylvania Ave'), 'address');
  assert.match(extractFunction('doSearch'), /type === 'badzip'\) \{\s*(\/\/.*\s*)?throw new Error\('Not a valid ZIP code/);
});

test('a station inside a warning says so to screen readers, not just with a red ring', () => {
  // Run the real flagging with a fake marker: one warning polygon that contains it.
  const outer = { title: '', setAttribute(k, v) { this[k] = v; } };
  const badge = { title: 'KSAT — San Antonio', dataset: { label: 'KSAT — San Antonio' },
                  classList: { on: false, toggle(c, v) { this.on = v; } }, closest: () => outer };
  const flag = inside => vm.runInNewContext(`(() => { ${extractFunction('flagStationsInAlerts')} return flagStationsInAlerts; })()`, {
    stationRecords: [{ el: badge, lat: 29.5, lng: -98.5 }],
    alertPolygons: () => [[]], pointInAlertPolygon: () => inside
  })([{ properties: { event: 'Flood Warning' } }]);
  flag(true);
  assert.equal(badge.title, 'KSAT — San Antonio — inside an active warning area');
  assert.equal(outer.title, badge.title);
  assert.equal(outer['aria-label'], badge.title, 'the focusable Leaflet box is what gets announced');
  flag(false);
  assert.equal(outer.title, 'KSAT — San Antonio');
  assert.equal(outer['aria-label'], 'KSAT — San Antonio');
  assert.match(extractFunction('makeStationMarker'), /markerEl\.setAttribute\('aria-label', label\);/);
  assert.match(extractFunction('makeStationMarker'), /iconEl\.dataset\.label = label;/);
});

test('alerts come before the map for keyboard users and small text keeps its contrast', () => {
  // Tab order follows the DOM: the alert banner must precede the map's many markers.
  assert.ok(html.indexOf('<div id="alert-banner"') < html.indexOf('<div id="map"'));
  assert.match(html, /\.overlay-text \{[^}]*color: var\(--text\);/);
  assert.match(html, /\.leaflet-tooltip\.alert-area-label \{[^}]*background: rgba\(10,14,23,0\.92\);/);
  // Very narrow screens: the badge rises above the one-line credits (no wrapping
  // into the Locate Me button).
  assert.match(html, /@media \(max-width: 340px\) \{\s*#app-version \{ bottom: calc\(20px \+ var\(--safe-bottom\)\); \}/);
  assert.doesNotMatch(html, /max-width: calc\(100vw - 84px/);
});

test('the version badge links to the GitHub repository in a new tab', () => {
  assert.match(html, /<a id="app-version" href="https:\/\/github\.com\/ArtemSkit\/weather-stations" target="_blank"\s+rel="noopener noreferrer" title="WX\.MAP on GitHub"><\/a>/);
  // It takes taps now (no click-through), and shows a keyboard focus ring.
  assert.doesNotMatch(html.match(/#app-version \{[^}]*\}/)[0], /pointer-events: none/);
  assert.match(html, /#app-version:focus-visible \{ outline: 2px solid var\(--text\); outline-offset: 2px; \}/);
  // The label names the link for screen readers, with the running version.
  const label = {};
  const badge = { setAttribute: (k, v) => { label[k] = v; } };
  vm.runInNewContext(`(${extractFunction('setVersionBadge')})('1.2.3')`, { document: { getElementById: () => badge } });
  assert.equal(badge.textContent, 'v1.2.3');
  assert.equal(label['aria-label'], 'WX.MAP version 1.2.3 — source code on GitHub (opens a new tab)');
});

test('Locate Me hides instead of covering the header when the sheet leaves no room', () => {
  assert.match(html, /const room = window\.innerHeight - mainEl\.getBoundingClientRect\(\)\.top - sheetH;\s*mainEl\.classList\.toggle\('sheet-crowded', room < 74\);/);
  assert.match(html, /sheetSpaceObserver\.observe\(mainEl\);/);
  assert.match(html, /window\.addEventListener\('resize', syncSheetSpace\);/);
  // initMobile runs outside the main script's closure: it must look the button up itself.
  assert.doesNotMatch(extractFunction('initMobile'), /\bfabLocate\b/);
  // The hiding rule must live inside the phone/sheet media block only.
  const rule = html.indexOf('main.sheet-open.sheet-crowded #fab-locate { visibility: hidden; }');
  const mobileBlock = html.indexOf('@media (pointer: coarse), (max-width: 640px) {');
  assert.ok(mobileBlock > 0 && rule > mobileBlock && rule < html.indexOf('</style>'));
  assert.equal(html.indexOf('#fab-locate { visibility: hidden; }'), html.lastIndexOf('#fab-locate { visibility: hidden; }'));
});

test('phone layout leaves room: sheet sized to the visible screen, toast above the map controls, pin mode closes the sheet', () => {
  assert.match(html, /max-height: 70vh !important;[^\n]*\s*(?:\/\*[\s\S]*?\*\/\s*)?max-height: 70dvh !important;/);
  // The toast sits above the LIVE ALERTS row (and so above Locate Me), never on it.
  assert.match(html, /#toast \{ bottom: calc\(145px \+ var\(--safe-bottom\)\); max-width: calc\(100vw - 108px - var\(--safe-left\) - var\(--safe-right\)\); \}\s*@media \(max-width: 340px\) \{\s*#toast \{ bottom: calc\(159px \+ var\(--safe-bottom\)\); \}/);
  assert.match(extractFunction('setTapMode'),
    /if \(active && popupPanel\.style\.display === 'block' && getComputedStyle\(popupPanel\)\.position === 'fixed'\) \{\s*closeStationPanel\(false\);/);
  // NWS renamed Excessive Heat to Extreme Heat in 2025: the short label follows.
  assert.match(html, /'extreme heat warning': 'EXTREME HEAT'/);
  assert.doesNotMatch(html, /excessive heat/i);
});

test('with the phone sheet open, the toast clears the lifted Locate Me button', () => {
  // Only while Locate Me is shown (not crowded), and inside the side safe areas.
  assert.match(html, /main\.sheet-open:not\(\.sheet-crowded\) ~ #toast \{\s*left: calc\(50% - 33px \+ \(var\(--safe-left\) - var\(--safe-right\)\) \/ 2\);\s*max-width: calc\(100vw - 82px - var\(--safe-left\) - var\(--safe-right\)\);/);
  assert.doesNotMatch(html, /\+ 74px\) !important/, 'lifting the toast higher pushed it onto the search bar');
  // The comment no longer claims User-Agent is a forbidden header.
  assert.doesNotMatch(html, /User-Agent is a forbidden fetch header/);
});

test('a cached rain chance is not shown after its forecast hour is over', async () => {
  const shown = [];
  const run = vm.runInNewContext(`(() => {
    let activeStationId = 'KSEA', stationOpenGeneration = 1, activeStationName = 'Test';
    ${extractFunction('isActiveStation')}
    return async ${extractFunction('refreshStationData')};
  })()`, {
    document: { getElementById: () => ({ classList: { add() {}, remove() {} }, textContent: '' }) },
    fetchObservations: async () => ({}),   // no geometry: no new forecast lookup
    renderWeather: (data, id, name, pop) => shown.push(pop),
    forecastPoPCache: new Map([
      ['KSEA', { pop: 60, ts: Date.now() - 6 * 3_600_000, ttl: 600_000, end: Date.now() - 5 * 3_600_000 }]
    ])
  });
  await run('KSEA', 1);
  assert.deepEqual(shown, [null], 'a 6-hour-old "this hr" value must not be shown');
});

test('network failures read as a plain message, and "no forecast grid" is not retried every 2 minutes', async () => {
  const fetchJson = fetchImpl => vm.runInNewContext(`(() => { return async ${extractFunction('fetchJsonWithTimeout')}; })()`,
    { fetch: fetchImpl, AbortController, setTimeout, clearTimeout });
  // Offline: fetch rejects with the browser's own TypeError text.
  await assert.rejects(fetchJson(async () => { throw new TypeError('Failed to fetch'); })('https://x'),
    /^Error: Network error — check your connection and try again$/);
  // Captive portal: an OK HTML page instead of JSON.
  await assert.rejects(fetchJson(async () => ({ ok: true, json: async () => { throw new SyntaxError("Unexpected token '<'"); } }))('https://x'),
    /Network error/);

  const cache = new Map();
  const fetchForecastPoP = new Function('fetchJsonWithTimeout', 'forecastPoPCache', `
    const FORECAST_TTL_MS = 600000, FORECAST_FAILURE_TTL_MS = 120000, FORECAST_CACHE_LIMIT = 100;
    function setBoundedCache(c, k, v) { c.set(k, v); }
    function isTrustedNwsApiUrl() { return true; }
    ${extractFunction('cachedForecastPoP')}
    async ${extractFunction('fetchForecastPoP')}
    return fetchForecastPoP;
  `)(async () => ({ response: { ok: false, status: 404 }, data: null }), cache);
  assert.equal(await fetchForecastPoP(27.0, -90.0, 'PLAT1'), null);
  assert.equal(cache.get('PLAT1').ttl, 600000, 'outside the forecast grid is a lasting answer');

  // Locate Me explains the HTTPS requirement instead of a "denied" it can't fix.
  assert.match(html, /if \(window\.isSecureContext === false\) \{\s*showToast\('Locate Me needs the app to be opened over HTTPS/);
});

test('a ?station link places the marker at the station record, not the rounded observation point', async () => {
  const point = reply => vm.runInNewContext(`(() => async ${extractFunction('fetchStationPoint')})()`,
    { fetchJsonWithTimeout: reply, encodeURIComponent, Array, Number });
  assert.deepEqual([...await point(async () => ({ response: { ok: true }, data: { geometry: { coordinates: [-73.76393, 40.63915] } } }))('KJFK')],
    [-73.76393, 40.63915]);
  // Any failure falls back (null) to the observation's own point.
  assert.equal(await point(async () => { throw new Error('Network error'); })('KJFK'), null);
  assert.equal(await point(async () => ({ response: { ok: false }, data: null }))('KJFK'), null);
  assert.match(html, /const \[lng, lat\] = sitePoint \|\| data\.geometry\?\.coordinates \|\| \[\];/);
  // The optional record must not hold the deep link for the default 15 s.
  assert.match(extractFunction('fetchStationPoint'), /encodeURIComponent\(stationId\)\}`, \{\}, 4000\)/);
});

test('a passing forecast failure keeps the current hour\'s rain chance', async () => {
  const now = Date.now();
  const cache = new Map([['KSEA', { pop: 40, ts: now - 11 * 60_000, ttl: 600_000, end: now + 30 * 60_000 }]]);
  const fetchForecastPoP = new Function('fetchJsonWithTimeout', 'forecastPoPCache', `
    const FORECAST_TTL_MS = 600000, FORECAST_FAILURE_TTL_MS = 120000, FORECAST_CACHE_LIMIT = 100;
    function setBoundedCache(c, k, v) { c.set(k, v); }
    function isTrustedNwsApiUrl() { return true; }
    ${extractFunction('cachedForecastPoP')}
    async ${extractFunction('fetchForecastPoP')}
    return fetchForecastPoP;
  `)(async () => ({ response: { ok: false, status: 503 }, data: null }), cache);
  // The hour has 30 minutes left: a 503 must not blank the row.
  assert.equal(await fetchForecastPoP(47.4, -122.3, 'KSEA'), 40);
  assert.equal(cache.get('KSEA').ttl, 120000, 'retried soon');
  // Once that hour is over, a failure means "no value".
  cache.set('KSEA', { pop: 40, ts: now - 11 * 60_000, ttl: 600_000, end: now - 1 });
  assert.equal(await fetchForecastPoP(47.4, -122.3, 'KSEA'), null);
});

test('a slow rain-chance lookup never holds up the next refresh', async () => {
  const shown = [];
  let resolveForecast;
  let forecastCalls = 0;
  const dot = { cls: new Set(), classList: { add(c) { dot.cls.add(c); }, remove(...c) { c.forEach(x => dot.cls.delete(x)); } } };
  let observation = 1;
  const ctx = vm.createContext({
    document: { getElementById: id => (id === 'update-dot' ? dot : { classList: { add() {}, remove() {} }, textContent: '' }) },
    fetchObservations: async () => ({ obs: observation++, geometry: { coordinates: [-98.5, 29.5] } }),
    fetchForecastPoP: () => { forecastCalls++; return new Promise(r => { resolveForecast = r; }); },   // hangs
    renderWeather: (data, id, name, pop) => shown.push([data.obs, pop]),
    forecastPoPCache: new Map(), Set, Array, Number, Date
  });
  const run = vm.runInContext(`(() => {
    let activeStationId = 'KSAT', stationOpenGeneration = 1, activeStationName = 'Test';
    ${extractFunction('isActiveStation')}
    let shownStation = null;
    const forecastPending = new Set();
    async ${extractFunction('refreshStationForecast')}
    async ${extractFunction('refreshStationData')}
    return refreshStationData;
  })()`, ctx);

  await run('KSAT', 1);   // returns although the forecast never answered
  assert.ok(!dot.cls.has('refreshing'), 'no yellow pulse once the readings are shown');
  await run('KSAT', 1);   // the next tick fetches a new observation right away
  assert.deepEqual(shown.map(s => s[0]), [1, 2]);
  assert.equal(forecastCalls, 1, 'one forecast lookup at a time per station');

  // When the forecast finally answers, the NEWEST observation is re-rendered with it.
  resolveForecast(55);
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(shown.at(-1), [2, 55]);
});

test('a late rain chance reaches a reopened panel and keeps an "update failed" note', async () => {
  const shown = [];
  let resolveForecast;
  const timeEl = { textContent: '' };
  const ctx = vm.createContext({
    document: { getElementById: id => (id === 'update-time' ? timeEl : { classList: { add() {}, remove() {} }, textContent: '' }) },
    fetchObservations: async () => ({ geometry: { coordinates: [-98.5, 29.5] } }),
    fetchForecastPoP: () => new Promise(r => { resolveForecast = r; }),
    renderWeather: (data, id, name, pop) => { shown.push(pop); timeEl.textContent = 'OBS: 1'; },
    forecastPoPCache: new Map(), Set, Array, Number, Date
  });
  const panel = vm.runInContext(`(() => {
    let activeStationId = 'KSAT', stationOpenGeneration = 1, activeStationName = 'Test';
    ${extractFunction('isActiveStation')}
    let shownStation = null;
    const forecastPending = new Set();
    async ${extractFunction('refreshStationForecast')}
    async ${extractFunction('refreshStationData')}
    return { refresh: refreshStationData, reopen: g => { stationOpenGeneration = g; } };
  })()`, ctx);

  await panel.refresh('KSAT', 1);   // opening 1: forecast lookup starts and hangs
  panel.reopen(3);                  // closed and reopened while it loads
  await panel.refresh('KSAT', 3);   // its own lookup is skipped (one per station)
  timeEl.textContent = 'OBS: 1 · update failed';   // and a later refresh failed
  resolveForecast(70);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(shown.at(-1), 70, 'the reopened panel gets the rain chance');
  assert.equal(timeEl.textContent, 'OBS: 1 · update failed', 'the failure note survives the re-render');
});

test('keyboard: the focused map shows a ring and a held Enter searches once', () => {
  // main clips overflow and the tile panes (z-index 400) would cover an inside
  // outline, so the ring is a layer above the tiles and below the controls (800).
  assert.match(html, /#map:focus-visible::after \{[^}]*z-index: 799;[^}]*box-shadow: inset 0 0 0 2px var\(--accent\);/);
  // High Contrast mode drops box-shadow; the transparent outline becomes the ring.
  assert.match(html, /#map:focus-visible::after \{[^}]*outline: 2px solid transparent; outline-offset: -2px;/);
  assert.match(html, /\} else if \(e\.key === 'Enter' && !e\.repeat\) \{[\s\S]{0,200}?else doSearch\(\);/);
});

test('search radius: nearby stations only, and the circle edge keeps clear of markers where the gaps allow', () => {
  const pick = vm.runInNewContext(`(() => {
    const SEARCH_RADIUS_MI = 50, SEARCH_MIN_STATIONS = 8, SEARCH_STRETCH = 1.25, SEARCH_INWARD = 0.7;
    ${extractFunction('milesBetween')}
    ${extractFunction('selectStationsInRadius')}
    return selectStationsInRadius;
  })()`);
  // Stations due north of (30, -98) at the given distances (1° of latitude ≈ 69.09 mi).
  const at = miles => ({ geometry: { coordinates: [-98, 30 + miles / 69.09] }, properties: {} });
  // 10% of the radius: a 14 px marker + gap on a ~200 px circle (desktop).
  const CLEAR = 0.1;
  const run = (list, clearance = CLEAR) => pick(30, -98, list.map(at), clearance);
  /** Every station inside the edge is shown, so "within N mi" is true. */
  const check = (list, r) => {
    const hiddenInside = list.filter(d => d < r.edgeMi - 0.1).length - r.inside.length;
    assert.equal(hiddenInside, 0, '"within N mi" must be true: no hidden station inside the edge');
  };

  // Plenty nearby with a clear gap after 49 mi: everything within 50 mi.
  let list = [5, 10, 15, 20, 25, 30, 35, 40, 45, 49, 80, 120];
  let r = run(list);
  assert.equal(r.inside.length, 10);
  assert.ok(r.edgeMi - 49 >= CLEAR * r.edgeMi - 0.01, 'room past the last station');
  check(list, r);

  // Sparse area: the nearest 8 even beyond 50 mi.
  list = [20, 60, 70, 75, 90, 100, 110, 130, 180, 250];
  r = run(list);
  assert.equal(r.inside.length, 8);
  assert.ok(r.edgeMi >= 130 / (1 - CLEAR) - 0.5 && r.edgeMi < 180);
  check(list, r);

  // The real Weatherford list: tight steps around 50 mi. The edge moves to a spot
  // with room (in or out, near 50 mi first) instead of crossing a marker.
  list = [10, 18, 25, 31, 38, 41, 44, 46.3, 50.2, 51.7, 53, 54.5, 57, 66, 70, 75, 81];
  r = run(list);
  assert.ok(r.edgeMi - r.inside.at(-1).mi >= CLEAR * r.edgeMi - 0.01, `room: ${JSON.stringify(r.inside.at(-1).mi)} → ${r.edgeMi}`);
  assert.ok(r.edgeMi >= 40 && r.edgeMi <= 66, `edge ${r.edgeMi}`);
  check(list, r);

  // A phone's smaller circle needs more room (18% of the radius) than this list has
  // anywhere near 50 mi: the edge then takes the widest gap in range (57 → 66 mi),
  // right up to the first station left out (which isn't drawn).
  r = run(list, 0.18);
  assert.ok(Math.abs(r.inside.at(-1).mi - 57) < 0.05);   // (great-circle vs. flat 69.09 mi/°)
  assert.ok(r.edgeMi > 65 && r.edgeMi < 66, `edge ${r.edgeMi}`);
  check(list, r);

  // Dense list (one station every mile to 200 mi): no room anywhere, so the widest
  // gap in range is used — the circle neither collapses nor runs away.
  list = Array.from({ length: 200 }, (_, i) => i + 1);
  r = run(list);
  assert.ok(r.edgeMi >= 35 && r.edgeMi <= 63, `edge ${r.edgeMi}`);
  check(list, r);

  // Nothing beyond the last station: just past it.
  r = run([10, 20]);
  assert.equal(r.inside.length, 2);
  assert.ok(r.edgeMi > 20);
  const none = run([]);
  assert.equal(none.inside.length, 0);
  assert.equal(none.edgeMi, 50);

  // No stations: no "0 stations" circle. Markers go on the circle's copy of the
  // world (western Aleutians), while the warning check keeps NWS's longitudes.
  const plot = extractFunction('plotStations');
  assert.match(plot, /if \(!inside\.length\) return undefined;\s*return drawSearchRadius/);
  assert.match(plot, /const onScreenLng = lng \+ 360 \* Math\.round\(\(lon - lng\) \/ 360\);[\s\S]*makeStationMarker\([^)]*onScreenLng\)[\s\S]*stationRecords\.push\(\{ el, lat: la, lng \}\)/);
  // A map smaller than the fit padding is centred, not fitted at a nonsense zoom.
  const fitCalls = [];
  const fit = vm.runInNewContext(`(${extractFunction('fitSearchRadius')})`, {
    SEARCH_FIT_PAD_X: 80, SEARCH_FIT_PAD_Y: 136, SEARCH_FIT_TOP: 96, SEARCH_FIT_EDGE: 40, SEARCH_FIT_MAX_ZOOM: 11,
    prefersReducedMotion: { matches: false },
    map: { getSize: () => ({ x: 400, y: 120 }), setView: () => fitCalls.push('setView'), flyToBounds: () => fitCalls.push('fly') }
  });
  assert.equal(fit({}, 30, -98), false);
  assert.deepEqual(fitCalls, ['setView']);

  // Never zoom OUT to fit: a user already closer in keeps their zoom (the map
  // just centres on the point); one further out still zooms in to the circle.
  const views = [];
  const fitAt = (userZoom, fitZoom) => vm.runInNewContext(`(${extractFunction('fitSearchRadius')})`, {
    SEARCH_FIT_PAD_X: 80, SEARCH_FIT_PAD_Y: 136, SEARCH_FIT_TOP: 96, SEARCH_FIT_EDGE: 40, SEARCH_FIT_MAX_ZOOM: 11,
    prefersReducedMotion: { matches: false }, L: { point: (x, y) => ({ x, y }) },
    map: { getSize: () => ({ x: 1200, y: 800 }), getBoundsZoom: () => fitZoom,
           setView: (c, z) => views.push(['setView', z]), flyToBounds: () => views.push(['fly']) }
  })({}, 30, -98, userZoom);
  assert.equal(fitAt(14, 9), false);
  assert.equal(fitAt(4, 9), true);
  assert.deepEqual(views, [['setView', 14], ['fly']]);
  const loadAt = extractFunction('loadStationsAt');
  assert.match(loadAt, /const userZoom = map\.getZoom\(\);\s*moveMapTo\(lat, lon, Math\.max\(8, userZoom\)\);[\s\S]*plotStations\(data, lat, lon, userZoom\)/);

  // The dimming appears once the map has landed (mid-flight Leaflet only scales
  // the old drawing), reaches past the screen while dragging, and covers every
  // world copy on screen; reduced motion means no glide either.
  const draw = extractFunction('drawSearchRadius');
  assert.match(draw, /started = true;\s*mask\.addTo\(searchRadiusLayer\)\.bringToBack\(\);/);
  assert.doesNotMatch(draw, /fillOpacity: [\d.]+, interactive: false\s*\}\)\.addTo/);
  assert.match(draw, /setTimeout\(\(\) => \{ if \(!document\.hidden\) startGrow\(\); \}, 2000\);/);
  assert.match(html, /L\.svg\(\{ pane: 'searchRadius', padding: 0\.5 \}\)/);
  assert.match(html, /const SEARCH_MASK_OUTER = \[\[-85, -1800\], \[85, -1800\], \[85, 1800\], \[-85, 1800\]\];/);
  assert.match(extractFunction('fitSearchRadius'), /map\.fitBounds\(bounds, \{ \.\.\.options, animate: false \}\)/);
  // A light dimming; the RADIUS switch hides the whole circle (CSS only, so it
  // comes back intact), shows only while a circle is drawn, and is remembered.
  assert.match(draw, /fillColor: '#101826', fillOpacity: 0\.2,/);
  assert.match(draw, /searchRadius = circle;\s*map\.getContainer\(\)\.classList\.add\('has-search-radius'\);/);
  assert.match(extractFunction('clearSearchRadius'), /classList\.remove\('has-search-radius'\)/);
  assert.match(html, /#search-radius-btn \{ display: none; \}\s*#map\.has-search-radius #search-radius-btn \{ display: inline-flex; \}/);
  assert.match(html, /#map\.radius-off \.leaflet-searchRadius-pane,\s*#map\.radius-off \.search-radius-label \{ display: none; \}/);
  // Narrow phones: just the ring, so the row never wraps into the banner's space.
  assert.match(html, /@media \(max-width: 389px\) \{\s*#search-radius-btn \.radius-text \{\s*position: absolute; width: 1px; height: 1px; overflow: hidden;/);
  assert.match(html, /<span class="ring" aria-hidden="true"><\/span><span class="radius-text">RADIUS<\/span>/);
  // The switch stays put while a new search loads, and goes when the search fails.
  assert.match(loadAt, /clearStations\(\);[\s\S]*?classList\.add\('has-search-radius'\);\s*setStatus\('loading'/);
  assert.match(loadAt, /if \(area === areaGeneration\) \{\s*areaLoading = null;\s*map\.getContainer\(\)\.classList\.remove\('has-search-radius'\);/);
  const toggleRadius = extractFunction('setSearchRadiusShown');
  assert.match(toggleRadius, /classList\.toggle\('radius-off', !shown\)/);
  assert.match(toggleRadius, /try \{ localStorage\.setItem\(SEARCH_RADIUS_HIDDEN_KEY, shown \? '0' : '1'\); \} catch/);
  // Alerts are looked for in the circle's own box (2 radii wide), not the fit box.
  assert.match(draw, /const area = L\.latLng\(lat, lon\)\.toBounds\(2 \* r\);\s*return \{ west: area\.getWest\(\)/);
});

test('live alerts: NWS colours, readable popup text, one view request at a time', () => {
  const colours = vm.runInNewContext(`(() => {
    ${html.match(/const LIVE_ALERT_COLORS = \{[\s\S]*?\n\};/)[0]}
    ${extractFunction('alertHue')}
    ${extractFunction('liveAlertColor')}
    ${extractFunction('liveAlertTextColor')}
    return { liveAlertColor, liveAlertTextColor };
  })()`);
  assert.equal(colours.liveAlertColor('Tornado Warning'), '#FF0000');
  assert.equal(colours.liveAlertColor('Extreme Heat Warning'), '#C71585');
  assert.match(colours.liveAlertColor('Something New'), /^hsl\(\d+, 70%, 60%\)$/);
  // A type named like a built-in object key gets a hashed colour, not a function.
  assert.match(colours.liveAlertColor('constructor'), /^hsl\(/);
  assert.match(colours.liveAlertTextColor('toString'), /^hsl\(/);
  // Dark NWS colours are lightened for text on the dark popup.
  assert.equal(colours.liveAlertTextColor('Flash Flood Warning'), 'rgb(197, 128, 128)');

  const load = extractFunction('loadLiveAlerts');
  // An answer is dropped once a newer one is drawn (or live alerts are off); an
  // older view's answer that arrives first is still drawn. Only the newest
  // request's failure is reported, and retries wait while the page is hidden.
  assert.match(load, /if \(seq <= liveAppliedSeq \|\| !liveAlertsOn\) return;/, 'answers older than the drawn one are dropped');
  assert.match(load, /liveAppliedSeq = seq;\s*if \(newest\) liveViewPending = false;/);
  assert.match(load, /catch \(error\) \{\s*if \(seq !== liveAlertsSeq \|\| !liveAlertsOn\) return;/, 'only the newest failure counts');
  assert.match(load, /liveRetryTimer = setTimeout\(refreshLiveAlerts, 30_000\);/);
  assert.match(extractFunction('setLiveAlerts'), /liveAlertsSeq\+\+;[^\n]*\n\s*liveAppliedSeq = liveAlertsSeq;/, 'switching off drops answers on their way');
  // Never a misleading count while the view's own answer is on its way.
  assert.match(html, /map\.on\('moveend', \(\) => \{\s*if \(!liveAlertsOn\) return;[\s\S]*?liveViewPending = true;/);
  assert.match(extractFunction('renderLiveLegend'), /liveViewPending \? '· …' : `· \$\{total\}`/);
  assert.match(load, /const tolerance = liveAlertTolerance\(map\.getZoom\(\)\)\.toFixed\(6\);[\s\S]*maxAllowableOffset: tolerance/, 'outlines simplified to the zoom');
  const toggle = extractFunction('setLiveAlerts');
  // The searched area's polygons are hidden with a class (kept intact), and the
  // full-map canvas is hidden when off so it can't catch their clicks. It is never
  // removed: Leaflet's canvas, added back after removal, draws nothing new until
  // the map moves (live alerts switched back on looked empty).
  assert.match(toggle, /classList\.toggle\('live-alerts-on', on\)/);
  assert.doesNotMatch(toggle, /removeLayer\(alertAreaGroup\)/);
  assert.doesNotMatch(toggle, /removeLayer\(liveAlertsRenderer\)/);
  assert.match(html, /#map:not\(\.live-alerts-on\) \.leaflet-liveAlerts-pane \{ display: none; \}/);
  assert.match(html, /#map\.live-alerts-on \.wx-alert-area,\s*#map\.live-alerts-on \.alert-area-label:not\(\.live-area-label\) \{ display: none; \}/);
  // Live mode: name chips on the live areas, and the banner lists the alerts in
  // view (rebuilt only when that set changes), following every move of the map.
  assert.match(html, /map\.on\('moveend', \(\) => \{\s*if \(!liveAlertsOn\) return;[\s\S]*?liveViewPending = true;[^\n]*\n\s*renderLiveView\(\);/);
  assert.match(extractFunction('renderLiveView'), /renderLiveLegend\(\);\s*renderLiveLabels\(\);\s*renderLiveBanner\(\);/);
  assert.match(extractFunction('renderLiveBanner'), /if \(signature === liveBannerSignature\) return;[\s\S]*renderAlertBanner\(features, true\);/);
  // (Held while the moved view's answer is on its way: no shrink-and-refill.)
  assert.match(extractFunction('renderLiveBanner'), /if \(!liveAlertsOn \|\| liveViewPending\) return;/);
  assert.match(extractFunction('renderLiveLabels'), /className: 'alert-area-label live-area-label'/);
  // …while the searched area's alerts keep updating underneath without replacing
  // it, and switching live mode off brings the searched area's banner back.
  assert.match(extractFunction('showAlerts'), /if \(!liveAlertsOn\) renderAlertBanner\(alerts\);/);
  assert.match(toggle, /renderAlertBanner\(shownAlerts\);/);
  // On or off is remembered: a reload brings live alerts back as they were left.
  assert.match(toggle, /liveAlertsOn = on;[\s\S]*?localStorage\.setItem\(LIVE_ALERTS_ON_KEY, on \? '1' : '0'\)/);
  // …waiting for the opening search's area when the app opens on a place to search
  // (no wasted download of the starting view: start-up moves are ignored), or
  // LIVE_DEFERRED_LOAD_MS at most.
  assert.match(html, /if \(localStorage\.getItem\(LIVE_ALERTS_ON_KEY\) === '1'\) \{[\s\S]*?setLiveAlerts\(true, \['station', 'lat', 'zip', 'addr'\]\.some\(key => opening\.has\(key\)\)\);/);
  assert.match(toggle, /liveWaitsForSearch = waitForSearch;\s*if \(waitForSearch\) \{[\s\S]*?setTimeout\(\(\) => liveDeferredLoad\(since\), LIVE_DEFERRED_LOAD_MS\);\s*\}\s*else loadLiveAlerts\(\);/);
  // The fallback keeps waiting while the opening search is still finding the
  // place (a slow lookup), up to a limit; once the area is drawn the load comes
  // soon (or at the landing of the fit's flight).
  const deferred = vm.runInNewContext(`(() => {
    let loads = 0, timers = [], now = 0;
    const LIVE_DEFERRED_MAX_MS = 20000;
    let liveWaitsForSearch = true, settledSearch = 0, searchGeneration = 1, liveMoveTimer = 0;
    const Date = { now: () => now };
    const setTimeout = fn => { timers.push(fn); return timers.length; };
    function loadLiveAlerts() { loads++; }
    ${extractFunction('liveDeferredLoad')}
    return {
      run: () => liveDeferredLoad(0), tick: ms => { now += ms; const fn = timers.shift(); fn && fn(); },
      settle: () => { settledSearch = searchGeneration; }, get loads() { return loads; }, get pending() { return timers.length; }
    };
  })()`);
  deferred.run();
  assert.equal(deferred.loads, 0, 'still looking the place up: keep waiting');
  assert.equal(deferred.pending, 1);
  deferred.settle();           // the lookup ended (the search failed or landed elsewhere)
  deferred.tick(1000);
  assert.equal(deferred.loads, 1);
  assert.match(extractFunction('liveSearchLanded'), /setTimeout\(\(\) => \{ if \(!mapMoving\) loadLiveAlerts\(\); \}, 350\);/);
  assert.match(html, /map\.on\('moveend', \(\) => \{\s*if \(!liveAlertsOn\) return;[^\n]*\n[^\n]*\n\s*if \(liveWaitsForSearch\) return;/);
  assert.match(extractFunction('loadStationsAt'), /plotStations\(data, lat, lon, userZoom\);[\s\S]*?liveSearchLanded\(\);/);
  // Pin mode: a tap on an alert area places the pin instead of opening a popup.
  const pieces = extractFunction('replaceLivePieces');
  assert.match(pieces, /if \(tapModeActive\) return;[\s\S]*openLiveAlertPopup\(props, e\.latlng, e\.originalEvent\)/);

  // A click on the open live popup's own alert closes it and leaves it closed (a
  // toggle): the click-away handler remembers that click, and the area's click
  // handler, which runs next with the same DOM event, then skips reopening it.
  assert.match(pieces, /if \(liveClosingClick\?\.event === e\.originalEvent && liveClosingClick\.capId === props\.cap_id\) return;/);
  const ctx = {
    pressStartedInMap: false, alertAreaOwners: new Map(), activeAlertAreaOwner: null,
    map: { closePopup() {} }, openAlertPopupElement: () => ({ contains: () => false }),
    livePopup: { isOpen: () => true }, livePopupCapId: 'cap-1', liveClosingClick: null
  };
  const clickAway = vm.runInNewContext(`(${extractFunction('handleAlertPopupClickAway')})`, ctx);
  const click = { detail: 1, target: { closest: () => null }, stopPropagation() {} };
  clickAway(click);
  assert.equal(ctx.liveClosingClick.event, click);
  assert.equal(ctx.liveClosingClick.capId, 'cap-1');
});

test('live alerts: each answer replaces what was drawn in its box (NOAA renumbers records)', () => {
  // A tiny stand-in for Leaflet: bounds are [west, south, east, north] boxes.
  const box = (w, s, e, n) => ({ w, s, e, n, intersects: o => !(o.e < w || o.w > e || o.n < s || o.s > n),
    getCenter: () => ({ lat: (s + n) / 2, lng: (w + e) / 2 }), isValid: () => true });
  const drawn = new Set();
  const fake = {
    L: { geoJSON: g => ({ g, on() {}, bringToFront() {}, setStyle() {},
      getBounds: () => (g.box ? box(...g.box) : { isValid: () => false }) }) },
    liveAlertsLayer: { addLayer: l => drawn.add(l), removeLayer: l => drawn.delete(l), hasLayer: l => drawn.has(l) },
    livePieces: new Set(), liveHiddenEvents: new Set(), liveAlertsRenderer: {}, tapModeActive: false,
    LIVE_SIG_RANK: { S: 0, Y: 1, A: 2, W: 3 }, liveAlertColor: () => '#fff', Date
  };
  const replace = vm.runInNewContext(`(() => {
    ${extractFunction('liveField')}
    ${extractFunction('liveAlertEnded')}
    ${extractFunction('restackLivePieces')}
    ${extractFunction('replaceLivePieces')}
    return replaceLivePieces;
  })()`, fake);
  const later = new Date(Date.now() + 3_600_000).toISOString();
  const piece = (event, b, extra = {}) => ({ geometry: { box: b },
    properties: { prod_type: event, sig: 'W', expiration: later, ends: ' ', cap_id: event, ...extra } });

  // First answer for a box: two warnings.
  replace([piece('Tornado Warning', [0, 0, 1, 1]), piece('Flood Warning', [2, 2, 3, 3])], [box(0, 0, 5, 5)], 0);
  assert.equal(fake.livePieces.size, 2);
  // A blank field (" ") is treated as empty, not as a date.
  assert.equal([...fake.livePieces][0].props.ends, undefined);
  // Next answer for the same box no longer lists the tornado warning (cancelled):
  // it is gone, whatever ids the service reused.
  replace([piece('Flood Warning', [2, 2, 3, 3])], [box(0, 0, 5, 5)], 0);
  assert.deepEqual([...fake.livePieces].map(p => p.props.prod_type), ['Flood Warning']);
  // An answer for a box elsewhere leaves this one's pieces alone…
  replace([piece('Gale Warning', [20, 20, 21, 21])], [box(19, 19, 25, 25)], 0);
  assert.equal(fake.livePieces.size, 2);
  // …but an alert that has ended is dropped anywhere: by its hazard end, or for a
  // statement without one, by its message's expiration.
  const past = new Date(Date.now() - 1000).toISOString();
  replace([piece('Heat Advisory', [40, 40, 41, 41], { ends: past }),
           piece('Special Weather Statement', [42, 42, 43, 43], { expiration: past })], [box(39, 39, 45, 45)], 0);
  replace([], [box(60, 60, 61, 61)], 0);
  assert.ok(![...fake.livePieces].some(p => ['Heat Advisory', 'Special Weather Statement'].includes(p.props.prod_type)));
  // A warning with no hazard end lasts "until further notice": a late follow-up
  // message (expiration passed) doesn't take it off the map.
  replace([piece('River Flood Warning', [50, 50, 51, 51], { expiration: past })], [box(49, 49, 55, 55)], 0);
  replace([], [box(60, 60, 61, 61)], 0);
  assert.ok([...fake.livePieces].some(p => p.props.prod_type === 'River Flood Warning'));
  // A piece with an empty outline (no bounds) is skipped, not kept to break later loads.
  const before = fake.livePieces.size;
  replace([{ geometry: { type: 'Polygon', coordinates: [] }, properties: { prod_type: 'Gale Warning', ends: later } }], [box(90, 90, 91, 91)], 0);
  assert.equal(fake.livePieces.size, before);
  // A long hazard whose MESSAGE has lapsed but whose hazard hasn't ended (a river
  // flood, a multi-day gale) stays: "ended" is the hazard's end, not the message's.
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  replace([piece('Flood Watch', [70, 70, 71, 71], { expiration: hourAgo, ends: later })], [box(69, 69, 75, 75)], 0);
  replace([], [box(80, 80, 81, 81)], 0);
  assert.ok([...fake.livePieces].some(p => p.props.prod_type === 'Flood Watch'));
  assert.equal(drawn.size, fake.livePieces.size, 'what is drawn matches the pieces kept');
  // After a long pan onto another copy of the world, the old copy's pieces (over
  // a full turn away) are dropped instead of kept until their alerts end.
  replace([], [box(430, 0, 440, 5)], 435);
  assert.ok(![...fake.livePieces].some(p => p.props.prod_type === 'Flood Watch'));
  assert.equal(drawn.size, fake.livePieces.size);
});

test('the map buttons fold away behind one small button, and the choice is remembered', () => {
  // ‹ comes first; the buttons it folds are grouped after it.
  assert.match(html, /<button type="button" id="map-tools-toggle" aria-expanded="true" aria-controls="map-tools"[\s\S]*?<\/button>\s*<div id="map-tools">\s*<button type="button" id="live-alerts-btn"[\s\S]*?id="live-legend-btn"[\s\S]*?id="search-radius-btn"[\s\S]*?<\/div>\s*<\/div>`;/);
  assert.match(html, /#map-tools\[hidden\] \{ display: none; \}/);
  assert.match(html, /#map\.live-alerts-on #map-tools-toggle\[aria-expanded="false"\] \.lamp \{ display: block; \}/);
  // Run the real toggle: folding hides the group and the colour key, and is stored.
  const stored = {}, calls = [];
  const ctx = {
    mapTools: { hidden: false }, mapToolsToggle: { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } },
    MAP_TOOLS_FOLDED_KEY: 'wxmap_tools_folded', setLiveLegendOpen: open => calls.push(open), liveAlertsOn: true,
    localStorage: { setItem: (k, v) => { stored[k] = v; } }
  };
  const setOpen = vm.runInNewContext(`(${extractFunction('setMapToolsOpen')})`, ctx);
  setOpen(false);
  assert.equal(ctx.mapTools.hidden, true);
  assert.equal(ctx.mapToolsToggle.attrs['aria-expanded'], 'false');
  assert.deepEqual(calls, [false]);
  assert.equal(stored.wxmap_tools_folded, '1');
  // Folded with live alerts on: screen readers hear it, not just a red dot.
  assert.equal(ctx.mapToolsToggle.attrs['aria-label'], 'Map buttons (live alerts on)');
  setOpen(true);
  assert.equal(ctx.mapTools.hidden, false);
  assert.equal(ctx.mapToolsToggle.attrs['aria-label'], 'Map buttons');
  assert.equal(stored.wxmap_tools_folded, '0');
  // Folded with live alerts off: no "(live alerts on)".
  ctx.liveAlertsOn = false;
  setOpen(false);
  assert.equal(ctx.mapToolsToggle.attrs['aria-label'], 'Map buttons');
  assert.match(html, /if \(localStorage\.getItem\(MAP_TOOLS_FOLDED_KEY\) === '1'\) setMapToolsOpen\(false\);/);
});

test('forecast: NWS 7-day and hourly forecasts for the searched area, from NOAA links only', async () => {
  // Markup: a header button (hidden until an area loads) and a modal dialog with two tabs.
  assert.match(html, /<button type="button" id="forecast-btn" hidden/);
  assert.match(html, /<dialog id="forecast-dialog" aria-labelledby="forecast-title">/);
  assert.match(html, /role="tab" id="fc-tab-days" aria-selected="true" aria-controls="fc-days"/);
  // Every loaded area (and a ?station link) points FORECAST at itself.
  assert.match(extractFunction('loadStationsAt'), /plotStations\(data, lat, lon, userZoom\);\s*setForecastPoint\(lat, lon\);/);
  assert.match(html, /stationRecords = \[\{ el: iconEl, lat, lng \}\];\s*setForecastPoint\(lat, lng\);/);

  // The loader follows only NOAA's own /gridpoints/ links and reads both forecasts.
  const requested = [];
  let extrasAsked = 0;
  const extrasHad = [];
  const answers = {
    'https://api.weather.gov/points/32.7600,-97.8000': { properties: {
      forecast: 'https://api.weather.gov/gridpoints/FWD/52,104/forecast',
      forecastHourly: 'https://api.weather.gov/gridpoints/FWD/52,104/forecast/hourly',
      relativeLocation: { properties: { city: 'Weatherford', state: 'TX',
        distance: { unitCode: 'wmoUnit:m', value: 13500 }, bearing: { unitCode: 'wmoUnit:degree_(angle)', value: 36 } } } } },
    'https://api.weather.gov/gridpoints/FWD/52,104/forecast': { properties: { updateTime: 'u', periods: [{ name: 'Tonight' }] } },
    'https://api.weather.gov/gridpoints/FWD/52,104/forecast/hourly': { properties: { periods: [{ number: 1 }, { number: 2 }] } }
  };
  const load = vm.runInNewContext(`(() => {
    const FORECAST_VIEW_TTL_MS = 600000, FORECAST_VIEW_CACHE_LIMIT = 20;
    const forecastViewCache = new Map();
    ${extractFunction('isTrustedNwsApiUrl')}
    ${extractFunction('setBoundedCache')}
    ${extractFunction('degToCompass')}
    ${extractFunction('forecastPlaceLabel')}
    ${extractFunction('hasAir')}
    ${extractFunction('hasPressure')}
    async ${extractFunction('fetchAreaForecast')}
    return fetchAreaForecast;
  })()`, { URL, Date, fetchJsonWithTimeout: async url => {
    requested.push(url);
    return { response: { ok: url in answers, status: url in answers ? 200 : 500 }, data: answers[url] };
  }, fetchAirAndPressure: async (lat, lon, have) => {
    extrasAsked++;   // the first answer fails entirely; the next brings both parts
    extrasHad.push(have);
    return extrasAsked === 1 ? { aqi: new Map(), pressure: new Map(), aqiNow: null }
      : { aqi: new Map(), pressure: new Map([['2026-10-03T20', 1015]]), aqiNow: 12 };
  } });
  const forecast = await load(32.76, -97.8);
  assert.equal(forecast.extras.aqiNow, null, 'air and pressure ride along (here: unavailable)');
  // Where it is: distance and direction from the NWS's nearest named place.
  assert.equal(forecast.place, '8 mi NE of Weatherford, TX');
  assert.equal(forecast.days.length, 1);
  assert.equal(forecast.hours.length, 2);
  await load(32.76, -97.8);
  assert.equal(requested.length, 3, 'a second open within minutes reuses the answer');
  // …but air and pressure missing last time are asked for again, not kept missing
  // (handing over what there is, so only the missing part is fetched).
  assert.equal(extrasAsked, 2);
  assert.equal(extrasHad[1].aqiNow, null);
  assert.equal(forecast.extras.aqiNow, 12);
  await load(32.76, -97.8);
  assert.equal(extrasAsked, 2, 'once they are in, they are reused too');
  const label = vm.runInNewContext(`(() => { ${extractFunction('degToCompass')} ${extractFunction('forecastPlaceLabel')} return forecastPlaceLabel; })()`);
  const at = (value, bearing, unitCode = 'wmoUnit:m') => ({ properties: { city: 'Boerne', state: 'TX',
    distance: { unitCode, value }, bearing: { value: bearing } } });
  assert.equal(label(at(0, 0)), 'Near Boerne, TX', 'inside the place (the NWS gives 0 m)');
  assert.equal(label(at(1200, 90)), 'Near Boerne, TX', 'under a mile');
  assert.equal(label(at(3376, 36)), '2 mi NE of Boerne, TX');
  assert.equal(label(at(2041, 232)), '1 mi SW of Boerne, TX');
  assert.equal(label(at(16.1, 350, 'wmoUnit:km')), '10 mi N of Boerne, TX');
  assert.equal(label(at(5000)), 'Near Boerne, TX', 'no bearing: no direction to give');
  // Out-of-range angles still name a direction (wrapped into 0–360).
  assert.equal(label(at(3376, -30)), '2 mi NNW of Boerne, TX');
  assert.equal(label(at(3376, 400)), '2 mi NE of Boerne, TX');
  assert.equal(label({ properties: { city: 'Boerne' } }), '');
  assert.equal(label(undefined), '');
  // A /points answer linking anywhere but NOAA's own API is refused.
  answers['https://api.weather.gov/points/40.0000,-100.0000'] = { properties: {
    forecast: 'https://evil.example/forecast', forecastHourly: 'https://api.weather.gov/gridpoints/X/1,1/forecast/hourly' } };
  await assert.rejects(load(40, -100), /no forecast for this spot/);
  assert.ok(!requested.includes('https://evil.example/forecast'));

  // Rendering: text is escaped, hours already over are skipped, each day gets a heading
  // in the PLACE's own clock (the timestamp's), and °C sits beside °F.
  // (escapeHtml's own quote regex trips extractFunction; this does the same job.)
  const escapeHtml = v => String(v ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  const r = vm.runInNewContext(`(() => {
    ${extractFunction('forecastEmoji')}
    ${extractFunction('forecastTemp')}
    ${extractFunction('forecastDegrees')}
    ${extractFunction('forecastDayPairs')}
    ${extractFunction('forecastLocalTime')}
    ${extractFunction('forecastHourLabel')}
    ${forecastExtrasSource}
    ${extractFunction('renderForecastDays')}
    ${extractFunction('renderForecastHours')}
    return { renderForecastDays, renderForecastHours, forecastEmoji, forecastTemp };
  })()`, { Date, escapeHtml });
  // One row per day: the day's high and the night's low (°C beneath), the night's
  // sky, the higher rain chance; a list starting at night has that night alone.
  const night = (name, temp, extra = {}) => ({ name, isDaytime: false, temperature: temp, temperatureUnit: 'F',
    shortForecast: 'Mostly Clear', detailedForecast: name + ' details.', ...extra });
  const day = (name, temp, extra = {}) => ({ name, isDaytime: true, temperature: temp, temperatureUnit: 'F',
    shortForecast: 'Sunny', detailedForecast: name + ' details.', windSpeed: '10 mph', windDirection: 'S', ...extra });
  const days = r.renderForecastDays([
    night('Tonight <b>', 68, { shortForecast: 'Chance Showers And Thunderstorms',
      probabilityOfPrecipitation: { value: 40 }, windSpeed: '5 mph', windDirection: 'SE' }),
    day('Friday', 73, { probabilityOfPrecipitation: { value: 20 } }),
    night('Friday Night', 63, { probabilityOfPrecipitation: { value: 60 } }),
    day('Saturday', 90)
  ]);
  const rows = days.split('<details').slice(1);
  assert.equal(rows.length, 3, 'Tonight, Friday (with its night), Saturday');
  assert.match(rows[0], /Tonight &#60;b&#62;/);
  assert.match(rows[0], /class="fc-lo"><span aria-hidden="true">↓<\/span><span class="sr-only">Low <\/span>68°<\/span><small>20°C<\/small>/);
  assert.doesNotMatch(rows[0], /fc-hi/);
  assert.match(rows[0], /💧 40% chance of rain · Wind SE 5 mph/);
  assert.match(rows[0], /⛈️/);
  assert.match(rows[1], /class="fc-hi">[^]*?High <\/span>73°<\/span><span class="fc-lo">[^]*?Low <\/span>63°<\/span><small>23° \/ 17°C<\/small>/);
  assert.match(rows[1], /<span class="fc-night-sky">Night: Mostly Clear<\/span>/);
  assert.match(rows[1], /💧 60% chance of rain · Wind S 10 mph/, 'the higher of the day and night chances');
  assert.match(rows[1], /<p><b>Friday:<\/b> Friday details\.<\/p><p><b>Friday Night:<\/b> Friday Night details\.<\/p>/);
  assert.match(rows[2], /High <\/span>90°<\/span><small>32°C<\/small>/);
  assert.doesNotMatch(rows[2], /fc-lo|Night:/);
  // A missing temperature: only the other one shows; with neither, a dash.
  const gaps = r.renderForecastDays([day('Sunday', null), night('Sunday Night', 61),
                                     day('Monday', null), night('Monday Night', undefined)]).split('<details').slice(1);
  assert.match(gaps[0], /<span class="fc-temps"><span class="fc-lo">[^]*?Low <\/span>61°<\/span><small>16°C<\/small><\/span>/);
  assert.doesNotMatch(gaps[0], /fc-hi/);
  assert.match(gaps[1], /<span class="fc-temps">—<\/span>/);
  // Given the place and Open-Meteo's data, the sun line (sunset first) and the air
  // line close the summary, and their details follow the forecaster's words.
  const sat = r.renderForecastDays(
    [day('Saturday', 90, { startTime: '2026-10-03T06:00:00-05:00', endTime: '2026-10-03T18:00:00-05:00' })],
    { aqi: new Map(Array.from({ length: 12 }, (_, i) => ['2026-10-03T' + (11 + i), { value: 120, pollutant: 'ozone' }])), pressure: new Map() },
    { lat: 29.42, lon: -98.49 });
  assert.match(sat, /<span class="fc-sun"><span class="fc-sunset">[^<]*<span aria-hidden="true">🌇 <\/span>Sunset 7:1\d PM<\/span>[^]*?<\/span><span class="fc-air"><span class="fc-aqi fc-aqi-3">AQI 120 Unhealthy for sensitive groups<\/span><\/span><\/summary><p><b>Saturday:<\/b> Saturday details\.<\/p><p><b>Daylight:<\/b>/);
  // Without them (no place, no data) a row is as before.
  assert.doesNotMatch(days, /fc-sun|fc-air|Daylight/);
  const now = Date.parse('2026-10-01T22:30:00-05:00');
  const hour = (start, end) => ({ startTime: start, endTime: end, temperature: 70, temperatureUnit: 'F',
    shortForecast: 'Clear', isDaytime: false, probabilityOfPrecipitation: { value: 0 } });
  const hours = r.renderForecastHours([
    hour('2026-10-01T21:00:00-05:00', '2026-10-01T22:00:00-05:00'),   // over: skipped
    hour('2026-10-01T22:00:00-05:00', '2026-10-01T23:00:00-05:00'),
    hour('2026-10-01T23:00:00-05:00', '2026-10-02T00:00:00-05:00'),
    hour('2026-10-02T00:00:00-05:00', '2026-10-02T01:00:00-05:00')
  ], now);
  assert.equal((hours.match(/class="fc-hour"/g) || []).length, 3);
  assert.deepEqual([...hours.matchAll(/fc-hour-day">([^<]+)</g)].map(m => m[1]), ['Thursday, Oct 1', 'Friday, Oct 2']);
  assert.match(hours, /fc-hour-time">10 PM</);
  assert.match(hours, /fc-hour-time">12 AM</);
  assert.doesNotMatch(hours, /fc-hour-air/);
  // Each hour gets its air quality and pressure, matched by UTC hour (23:00 CDT = 04 UTC).
  const aired = r.renderForecastHours([hour('2026-10-01T23:00:00-05:00', '2026-10-02T00:00:00-05:00')], now,
    { aqi: new Map([['2026-10-02T04', { value: 44, pollutant: 'ozone' }]]), pressure: new Map([['2026-10-02T04', 1013.25]]) });
  assert.match(aired, /<span class="fc-hour-air"><span class="fc-aqi fc-aqi-1">AQI 44 Good<\/span> · 29\.92 inHg<\/span>/);
  assert.equal(r.forecastEmoji('Mostly Sunny', true), '⛅');
  assert.equal(r.forecastEmoji('Clear', false), '🌙');
  assert.equal(r.forecastTemp({ temperature: null }), '—');

  // Error text reads as one sentence next to the Try again button.
  const reason = vm.runInNewContext(`(${extractFunction('forecastErrorReason')})`);
  assert.equal(reason(new Error('Request timed out — please try again')), 'request timed out');
  assert.equal(reason(new Error('Network error — check your connection and try again')), 'network error — check your connection');
  assert.equal(reason(new Error('the NWS answered HTTP 500')), 'the NWS answered HTTP 500');
  assert.equal(reason(null), 'no answer');
  // A failed search (the map moved, the stations cleared) hides FORECAST.
  assert.match(extractFunction('loadStationsAt'), /classList\.remove\('has-search-radius'\);[^\n]*\n\s*clearForecastPoint\(\);/);
  // The area went away behind an open forecast: Try again says so (no silent
  // no-op, and a late answer for the old area is ignored); closing then puts
  // focus on the search box (FIND on touch screens) instead of the hidden button.
  const panels = { days: { innerHTML: 'old' }, hours: { innerHTML: 'old' } };
  const fctx = { forecastPoint: null, forecastSeq: 3, forecastDialog: { open: true },
                 fcDays: panels.days, fcHours: panels.hours, forecastNow: { hidden: false },
                 forecastPlace: { textContent: 'Near Weatherford, TX' }, forecastFoot: { textContent: 'updated' } };
  await vm.runInNewContext(`(async ${extractFunction('openForecast')})`, fctx)();
  assert.match(panels.days.innerHTML, /no area on the map anymore — search for a place first/);
  assert.equal(fctx.forecastPlace.textContent, '', 'no "Near …" for a place that is gone');
  assert.equal(fctx.forecastNow.hidden, true, '…nor its air quality');
  assert.equal(fctx.forecastFoot.textContent, 'National Weather Service');
  assert.equal(panels.hours.innerHTML, panels.days.innerHTML);
  assert.equal(fctx.forecastSeq, 4);
  // (Touch screens: FIND, not the search box — no keyboard popping up.)
  assert.match(html, /forecastDialog\.addEventListener\('close', \(\) => \{[\s\S]*?if \(!forecastBtn\.hidden \|\| !stranded\) return;\s*\(window\.matchMedia\('\(pointer: coarse\)'\)\.matches \? searchBtn : zipInput\)\.focus\(\);/);
  // Phones: the home-bar room is inside the sheet, so a tap there doesn't close it.
  assert.match(html, /\.fc-foot \{ padding-bottom: calc\(8px \+ var\(--safe-bottom\)\); \}/);
  assert.doesNotMatch(html.match(/#forecast-dialog \{\s*width: 100vw;[^}]*\}/)[0], /padding-bottom/);
});

/** The forecast row helpers (sun, air, pressure) in a vm, with what they lean on. */
function forecastExtrasKit() {
  return vm.runInNewContext(`(() => {
    ${extractFunction('forecastLocalTime')}
    ${extractFunction('forecastHourLabel')}
    ${forecastExtrasSource}
    return { sunTimes, clockLabel, isoOffsetMinutes, durationLabel, aqiCategory, forecastRowExtras };
  })()`, { Date });
}

test('sun times match the US Naval Observatory to within a minute', () => {
  const k = forecastExtrasKit();
  // Reference times from aa.usno.navy.mil (rise/set and civil twilight), local clock.
  const near = (ms, offset, hhmm, what) => {
    const [, h, m, ampm] = /^(\d+):(\d\d) (AM|PM)$/.exec(k.clockLabel(ms, offset));
    const got = (+h % 12 + (ampm === 'PM' ? 12 : 0)) * 60 + +m;
    const [H, M] = hhmm.split(':').map(Number);
    assert.ok(Math.abs(got - (H * 60 + M)) <= 1, `${what}: ${k.clockLabel(ms, offset)} vs ${hhmm}`);
  };
  let s = k.sunTimes('2026-10-03', 29.42, -98.49);   // San Antonio, CDT
  near(s.light.rise, -300, '07:05', 'first light'); near(s.sun.rise, -300, '07:28', 'sunrise');
  near(s.sun.set, -300, '19:17', 'sunset');          near(s.light.set, -300, '19:41', 'last light');
  s = k.sunTimes('2026-03-08', 40.71, -74.01);       // New York, the day daylight saving starts
  near(s.sun.rise, -240, '07:19', 'sunrise'); near(s.sun.set, -240, '18:55', 'sunset');
  near(s.light.set, -240, '19:23', 'last light');
  // Utqiaġvik, Alaska: midnight sun in June; in December the sun stays down,
  // with three hours of twilight around noon.
  s = k.sunTimes('2026-06-21', 71.29, -156.79);
  assert.equal(s.sun, 'up'); assert.equal(s.light, 'up');
  s = k.sunTimes('2026-12-21', 71.29, -156.79);
  assert.equal(s.sun, 'down');
  near(s.light.rise, -540, '11:56', 'twilight start'); near(s.light.set, -540, '14:55', 'twilight end');
  // Next to the date line the times still belong to the date asked for (American Samoa, UTC−11).
  s = k.sunTimes('2026-10-03', -14.28, -170.7);
  assert.equal(new Date(s.sun.rise - 660 * 60_000).toISOString().slice(0, 10), '2026-10-03');
  assert.equal(new Date(s.sun.set - 660 * 60_000).toISOString().slice(0, 10), '2026-10-03');
  assert.equal(k.sunTimes('soon', 29, -98), null);
  assert.equal(k.isoOffsetMinutes('2026-10-03T06:00:00-05:00'), -300);
  assert.equal(k.isoOffsetMinutes('2026-10-03T06:00:00+05:30'), 330);
  assert.equal(k.isoOffsetMinutes('2026-10-03T06:00:00Z'), 0);
  assert.equal(k.isoOffsetMinutes('2026-10-03T06:00'), null);
  assert.equal(k.durationLabel(11 * 3600e3 + 49 * 60e3 + 40e3), '11 h 50 min');
});

test('forecast rows: sunset first at a glance, then air quality and pressure', () => {
  const k = forecastExtrasKit();
  const sa = { lat: 29.42, lon: -98.49 };
  const parts = [
    { startTime: '2026-10-03T06:00:00-05:00', endTime: '2026-10-03T18:00:00-05:00' },
    { startTime: '2026-10-03T18:00:00-05:00', endTime: '2026-10-04T06:00:00-05:00' }
  ];
  // Open-Meteo's hours are UTC keys: the row (06:00 CDT to 06:00 CDT next day) is
  // 2026-10-03T11 … 2026-10-04T10. `hours(n, from, value)` fills n of them.
  const hours = (n, from, value) => new Map(Array.from({ length: n }, (_, i) =>
    [new Date(Date.parse(from + ':00:00Z') + i * 3600e3).toISOString().slice(0, 13), value(i)]));
  const aqi = hours(24, '2026-10-03T11', () => ({ value: 30, pollutant: 'fine particles (PM2.5)' }));
  aqi.set('2026-10-03T20', { value: 58, pollutant: 'ozone' });     // 3 PM CDT
  aqi.set('2026-10-03T10', { value: 200, pollutant: 'ozone' });    // 5 AM: before the row
  aqi.set('2026-10-04T11', { value: 300, pollutant: 'ozone' });    // the next row's
  const pressure = hours(24, '2026-10-03T11', i => 1020 - i * 0.27);   // 1020 → ~1013.8
  pressure.set('2026-10-04T08', 1013.4);                             // 3 AM CDT: the low
  pressure.set('2026-10-04T11', 990);                                // the next row's
  const extras = { aqi, pressure };
  const row = k.forecastRowExtras(parts, extras, sa);
  // Sunset leads, highlighted; sunrise follows.
  assert.match(row.sun, /^<span class="fc-sunset"><span aria-hidden="true">🌇 <\/span>Sunset 7:1\d PM<\/span> · <span aria-hidden="true">🌅 <\/span>Sunrise 7:2\d AM$/);
  assert.match(row.air, /^<span class="fc-aqi fc-aqi-2">AQI 58 Moderate<\/span> · Pressure falling sharply, 30\.12 → 29\.94 inHg$/);
  // Opened: the whole day in order, twilight included; the air at its worst and why
  // (at the place's 3 PM, not UTC's); the pressure swing in both units and its low.
  assert.match(row.facts, /<p><b>Daylight:<\/b> first light 7:0\d AM · sunrise 7:2\d AM · sunset 7:1\d PM · last light 7:4\d PM \(11 h \d+ min of sun\)<\/p>/);
  assert.match(row.facts, /<p><b>Air quality:<\/b> up to 58, moderate — mostly ozone, worst around 3 PM\. Unusually sensitive people/);
  assert.match(row.facts, /<p><b>Pressure:<\/b> 30\.12 → 29\.94 inHg \(1020 → 1014 hPa\), falling sharply by 6 hPa; lowest 29\.93 inHg around 3 AM\.<\/p>/);

  // An air-quality forecast ending inside the row: with half the row or more it is
  // shown and says where it stops; with less, it isn't passed off as the whole day.
  const half = k.forecastRowExtras(parts, { aqi: hours(13, '2026-10-03T11', () => ({ value: 40, pollutant: 'ozone' })), pressure: new Map() }, sa);
  assert.match(half.facts, /worst around 6 AM; the air-quality forecast runs to 6 PM\./);
  const few = k.forecastRowExtras(parts, { aqi: hours(3, '2026-10-03T11', () => ({ value: 40, pollutant: 'ozone' })), pressure: new Map() }, sa);
  assert.equal(few.air, '');
  assert.doesNotMatch(few.facts, /Air quality/);
  // A small change is "steady", shown as one value; no air data, no air line.
  const calm = k.forecastRowExtras(parts, { aqi: new Map(), pressure: hours(24, '2026-10-03T11', i => 1016 + i / 23) }, sa);
  assert.equal(calm.air, 'Pressure steady, 30.02 inHg');
  assert.match(calm.facts, /\(1016 → 1017 hPa\), steady; lowest/);
  // The change adds up with the rounded ends shown beside it (2.2 hPa, shown 1013 → 1016).
  const up = k.forecastRowExtras(parts, { aqi: new Map(), pressure: hours(24, '2026-10-03T11', i => 1013.4 + i * 2.2 / 23) }, sa);
  assert.match(up.facts, /\(1013 → 1016 hPa\), rising by 3 hPa;/);
  // The fall-back day: the hours after 2 AM are on CST, so 3 PM CST is 21:00 UTC.
  const fallBack = [{ startTime: '2026-11-01T06:00:00-06:00', endTime: '2026-11-01T18:00:00-06:00' }];
  const nov = hours(12, '2026-11-01T12', () => ({ value: 20, pollutant: 'ozone' }));
  nov.set('2026-11-01T21', { value: 70, pollutant: 'ozone' });
  assert.match(k.forecastRowExtras(fallBack, { aqi: nov, pressure: new Map() }, sa).facts, /up to 70, moderate — mostly ozone, worst around 3 PM/);
  // A night on its own: the sunset it starts with and the NEXT morning's sunrise
  // (Minneapolis: Oct 3's sunrise was 7:13 AM, Oct 4's is 7:15 AM) — the same for
  // "Tonight" (from 6 PM) and "Overnight" (from midnight). Opened: in time order.
  const msp = { lat: 44.98, lon: -93.27 };
  const nightRow = (startTime, endTime) => k.forecastRowExtras([{ isDaytime: false, startTime, endTime }], null, msp);
  for (const night of [nightRow('2026-10-03T18:00:00-05:00', '2026-10-04T06:00:00-05:00'),
                       nightRow('2026-10-04T00:00:00-05:00', '2026-10-04T06:00:00-05:00')]) {
    assert.match(night.sun, /Sunset 6:51 PM<\/span> · <span aria-hidden="true">🌅 <\/span>Sunrise 7:15 AM$/);
    assert.match(night.facts, /<p><b>Daylight:<\/b> sunset 6:51 PM · last light 7:2\d PM · first light 6:4\d AM · sunrise 7:15 AM \(12 h 2\d min from sunset to sunrise\)<\/p>/);
  }
  // A day row keeps that day's own sunrise and sunset (Oct 4: 7:15 AM, 6:49 PM).
  assert.match(k.forecastRowExtras([{ isDaytime: true, startTime: '2026-10-04T06:00:00-05:00', endTime: '2026-10-04T18:00:00-05:00' }], null, msp).sun,
    /Sunset 6:49 PM<\/span> · <span aria-hidden="true">🌅 <\/span>Sunrise 7:15 AM$/);
  // The nights the midnight sun or polar night starts or ends (Utqiaġvik): each
  // half as it is, never a whole "no sunset" for a night that has one.
  const polarNight = (startTime, endTime) =>
    k.forecastRowExtras([{ isDaytime: false, startTime, endTime }], null, { lat: 71.29, lon: -156.79 });
  const may10 = polarNight('2026-05-10T18:00:00-08:00', '2026-05-11T06:00:00-08:00');   // midnight sun from May 11
  assert.match(may10.sun, /Sunset 1:\d\d AM \(after midnight\)<\/span> · then the sun stays up$/);
  assert.match(may10.facts, /<p><b>Daylight:<\/b> sunset 1:\d\d AM \(after midnight\) · then the sun stays up all day\.<\/p>/);
  const nov19 = polarNight('2026-11-19T18:00:00-09:00', '2026-11-20T06:00:00-09:00');   // polar night from Nov 20
  assert.match(nov19.sun, /Sunset 1:2\d PM<\/span> · No sunrise$/);
  assert.match(nov19.facts, /sunset 1:2\d PM · last light 4:1\d PM · no sunrise: the sun stays down all day, with twilight from 10:\d\d AM to 4:\d\d PM\./);
  const jan22 = polarNight('2027-01-22T18:00:00-09:00', '2027-01-23T06:00:00-09:00');   // the sun is back Jan 23
  assert.match(jan22.sun, /No sunset<\/span> · <span aria-hidden="true">🌅 <\/span>Sunrise 1:1\d PM$/);
  assert.match(jan22.facts, /no sunset · first light 10:3\d AM · sunrise 1:1\d PM\./);
  // Fairbanks in June: the sunset comes after midnight, and says so.
  const fairbanks = k.forecastRowExtras([{ startTime: '2026-06-21T06:00:00-08:00', endTime: '2026-06-21T18:00:00-08:00' }], null, { lat: 64.84, lon: -147.72 });
  assert.match(fairbanks.sun, /Sunset 12:\d\d AM \(after midnight\)<\/span> · <span aria-hidden="true">🌅 <\/span>Sunrise 2:\d\d AM$/);
  // Polar summer and winter (Utqiaġvik).
  const pole = { lat: 71.29, lon: -156.79 };
  const june = k.forecastRowExtras([{ startTime: '2026-06-21T06:00:00-08:00', endTime: '2026-06-21T18:00:00-08:00' }], null, pole);
  assert.match(june.sun, /No sunset<\/span> — the sun stays up all day/);
  const dec = k.forecastRowExtras([{ startTime: '2026-12-21T06:00:00-09:00', endTime: '2026-12-21T18:00:00-09:00' }], null, pole);
  assert.match(dec.sun, /No sunrise — the sun stays down all day/);
  assert.match(dec.facts, /twilight from 11:5\d AM to 2:5\d PM/);
  // Nothing to go on (no place, or a timestamp without its offset): nothing shown.
  assert.deepEqual({ ...k.forecastRowExtras(parts, null, null) }, { sun: '', air: '', facts: '' });
  assert.equal(k.forecastRowExtras([{ startTime: '2026-10-03T06:00', endTime: '2026-10-03T18:00' }], null, sa).sun, '');
  // EPA categories at their edges.
  assert.deepEqual([50, 51, 101, 151, 201, 301].map(v => k.aqiCategory(v).level), [1, 2, 3, 4, 5, 6]);
});

test('air quality and pressure: Open-Meteo, rounded position, never fatal', async () => {
  const requested = [];
  let answer = () => ({ ok: true, data: {} });
  const fetchAirAndPressure = vm.runInNewContext(`(() => {
    ${html.match(/const OPEN_METEO_AIR\s+= '[^']+';/)[0]}
    ${html.match(/const OPEN_METEO_FORECAST = '[^']+';/)[0]}
    ${html.match(/const AQI_POLLUTANTS = \{[\s\S]*?\};/)[0]}
    ${extractFunction('hasAir')}
    ${extractFunction('hasPressure')}
    async ${extractFunction('fetchAirAndPressure')}
    return fetchAirAndPressure;
  })()`, { fetchJsonWithTimeout: async url => {
    requested.push(url);
    const r = answer(url);
    if (r instanceof Error) throw r;
    return { response: { ok: r.ok }, data: r.data };
  } });
  answer = url => url.includes('air-quality')
    ? { ok: true, data: { current: { us_aqi: 35.6 }, hourly: {
        time: ['2026-10-03T00:00', '2026-10-03T01:00', '2026-10-03T02:00'],
        us_aqi: [42, null, 61], us_aqi_pm2_5: [42, null, 20], us_aqi_ozone: [30, null, 61] } } }
    : { ok: true, data: { hourly: { time: ['2026-10-03T00:00', '2026-10-03T01:00'], pressure_msl: [1016.2, null] } } };
  const got = await fetchAirAndPressure(29.5312, -98.4712);
  // About 11 km of rounding: never the exact spot.
  // …and in UTC hours, which line up with the NWS's across daylight-saving changes
  // and time-zone lines (the rounded point may fall in the next zone).
  assert.match(requested[0], /^https:\/\/air-quality-api\.open-meteo\.com\/v1\/air-quality\?latitude=29\.5&longitude=-98\.5&timezone=GMT&/);
  assert.match(requested[1], /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?latitude=29\.5&longitude=-98\.5&timezone=GMT&forecast_days=8&hourly=pressure_msl$/);
  assert.equal(got.aqiNow, 36);
  assert.deepEqual([...got.aqi.keys()], ['2026-10-03T00', '2026-10-03T02'], 'hours without a value are left out');
  assert.equal(got.aqi.get('2026-10-03T00').pollutant, 'fine particles (PM2.5)');
  assert.equal(got.aqi.get('2026-10-03T02').pollutant, 'ozone');
  assert.equal(JSON.stringify([...got.pressure]), '[["2026-10-03T00",1016.2]]');
  // Credited as the licences ask — Open-Meteo, and CAMS for the air data — for
  // what is shown, and what couldn't be had is said to be missing.
  const credit = vm.runInNewContext(`(() => {
    ${extractFunction('hasAir')} ${extractFunction('hasPressure')} ${extractFunction('airSourcesHtml')}
    return airSourcesHtml;
  })()`);
  const text = html => html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');
  const both = { aqi: new Map([['k', {}]]), aqiNow: 30, pressure: new Map([['k', 1015]]) };
  assert.equal(text(credit(both)), ' · Air quality & pressure: Open-Meteo (air data: Copernicus CAMS)');
  assert.equal(text(credit({ ...both, aqi: new Map(), aqiNow: null })),
    ' · Pressure: Open-Meteo · Air quality is unavailable right now', 'no CAMS credit without its data');
  assert.equal(text(credit({ ...both, pressure: new Map() })),
    ' · Air quality: Open-Meteo (air data: Copernicus CAMS) · The pressure forecast is unavailable right now');
  assert.equal(credit(null), ' · Air quality and pressure are unavailable right now');
  assert.match(credit(both), /<a href="https:\/\/open-meteo\.com\/" target="_blank" rel="noopener">Open-Meteo<\/a>/);
  assert.match(extractFunction('openForecast'), /forecast\.updated[^\n]*\n\s*airSourcesHtml\(extras\);/);
  // Given an earlier answer that has the pressure, only the air quality is asked
  // for again, and the pressure is kept as it was.
  requested.length = 0;
  const again = await fetchAirAndPressure(29.5, -98.5, { aqi: new Map(), aqiNow: null, pressure: got.pressure });
  assert.equal(requested.length, 1);
  assert.match(requested[0], /air-quality/);
  assert.equal(again.pressure, got.pressure);
  assert.equal(again.aqiNow, 36);
  // A part that fails is simply empty; nothing throws.
  answer = url => (url.includes('air-quality') ? new TypeError('Failed to fetch') : { ok: false });
  const none = await fetchAirAndPressure(29.5, -98.5);
  assert.equal(none.aqi.size + none.pressure.size, 0);
  assert.equal(none.aqiNow, null);
});

test('live alerts: a whole-world view replaces every piece, and date-line zones are drawn once', () => {
  const load = extractFunction('loadLiveAlerts');
  // The single -180…180 box of a zoomed-out view would never clear shapes placed
  // around the centre outside it; a whole-world answer clears everything instead.
  assert.match(load, /boxes\.length === 1 && boxes\[0\]\.east - boxes\[0\]\.west >= 360\s*\? \[L\.latLngBounds\(\[-90, -1e6\], \[90, 1e6\]\)\]/);
  // Shapes are placed around the view that was asked for, captured before the wait.
  assert.match(load, /const nearLon = \(b\.getWest\(\) \+ b\.getEast\(\)\) \/ 2;[\s\S]*await Promise\.all/);
  assert.doesNotMatch(load, /map\.getCenter\(\)/);
  // A zone split at the date line comes back in both boxes' answers: kept once.
  assert.match(load, /const key = `\$\{f\?\.properties\?\.cap_id\}\|\$\{JSON\.stringify\(f\?\.geometry\)\}`;/);
});

test('live alerts across the date line: the view is split, and shapes land on the copy on screen', () => {
  const h = vm.runInNewContext(`(() => {
    ${extractFunction('liveQueryBoxes')}
    ${extractFunction('placeGeometry')}
    return { liveQueryBoxes, placeGeometry };
  })()`);
  const plain = boxes => JSON.parse(JSON.stringify(boxes));   // sandbox arrays → plain ones
  // An ordinary view: one box, no shift.
  assert.deepEqual(plain(h.liveQueryBoxes(-110, 25, -90, 40)), [{ west: -110, south: 25, east: -90, north: 40, shift: 0 }]);
  // Alaska including the western Aleutians / Bering Sea (view from -195 to -140):
  // one box from +165 to 180 moved back by 360°, and one from -180 to -140.
  assert.deepEqual(plain(h.liveQueryBoxes(-195, 50, -140, 72)), [
    { west: 165, south: 50, east: 180, north: 72, shift: -360 },
    { west: -180, south: 50, east: -140, north: 72, shift: 0 }
  ]);
  // A view panned onto the next copy of the world (+200 … +230): moved onto it.
  assert.deepEqual(plain(h.liveQueryBoxes(200, 30, 230, 45)), [{ west: -160, south: 30, east: -130, north: 45, shift: 360 }]);
  // Zoomed far out: the whole world once; latitudes clamped.
  assert.deepEqual(plain(h.liveQueryBoxes(-400, -95, 300, 95)), [{ west: -180, south: -85, east: 180, north: 85, shift: 0 }]);

  const coords = g => JSON.parse(JSON.stringify(g.coordinates));
  // A western-Aleutian shape (+172…+179) viewed from Alaska (centre -150) moves next to it.
  const moved = h.placeGeometry({ type: 'MultiPolygon', coordinates: [[[[172, 52], [179, 52], [179, 55], [172, 52]]]] }, -150);
  assert.deepEqual(coords(moved), [[[[-188, 52], [-181, 52], [-181, 55], [-188, 52]]]]);
  // A shape that crosses the date line (+178 → -178) stays one small shape instead
  // of a band around the world.
  const crossing = h.placeGeometry({ type: 'Polygon', coordinates: [[[178, 60], [-178, 60], [-178, 62], [178, 62], [178, 60]]] }, -150);
  assert.deepEqual(coords(crossing), [[[-182, 60], [-178, 60], [-178, 62], [-182, 62], [-182, 60]]]);
  // An ordinary shape near the centre is left where it is.
  const plainShape = h.placeGeometry({ type: 'Polygon', coordinates: [[[-98, 30], [-97, 30], [-97, 31], [-98, 30]]] }, -96);
  assert.deepEqual(coords(plainShape), [[[-98, 30], [-97, 30], [-97, 31], [-98, 30]]]);
  // A hole moves with its outer ring even when its own middle is on the other side
  // of "half a turn away" (from 179: outer middle -1 is 180° off and moves a turn,
  // hole middle +0.5 is 178.5° off and alone would stay put, outside its polygon).
  const holed = h.placeGeometry({ type: 'Polygon', coordinates: [
    [[-3, 0], [1, 0], [1, 4], [-3, 4]], [[0, 1], [1, 1], [1, 2], [0, 2]]] }, 179);
  const [outer, hole] = coords(holed);
  assert.deepEqual(outer.map(c => c[0]), [357, 361, 361, 357]);
  assert.deepEqual(hole.map(c => c[0]), [360, 361, 361, 360], 'the hole stays inside its polygon');
  // An empty outline is left empty (no NaN longitudes for Leaflet to throw on).
  assert.deepEqual(coords(h.placeGeometry({ type: 'Polygon', coordinates: [[]] }, -150)), [[]]);
});
