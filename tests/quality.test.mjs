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
    function clearAlerts() {}
    function clearStations() { stationMarkers = []; }
    function moveMapTo() {}
    function plotStations() { stationMarkers = [1, 2]; log.push('plotted'); }
    function setStatus(state, text) { log.push('status:' + state + ':' + text); }
    function showOverlay(m) { log.push('overlay:' + m); }
    function hideOverlay() { log.push('overlay hidden'); }
    function showToast(m) { log.push('toast:' + m); }
    function loadAlertsForArea() { log.push('alerts'); }
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
    getSize: () => size,
    setView: () => calls.push('setView'),
    flyTo: () => calls.push('flyTo')
  });
  const makeMove = (size, reduced = false) => vm.runInNewContext(`(${extractFunction('moveMapTo')})`, {
    map: fakeMap(size), prefersReducedMotion: { matches: reduced }
  });
  makeMove({ x: 0, y: 0 })(1, 2, 10);       // laid out while hidden: flyTo would throw NaN
  makeMove({ x: 800, y: 600 })(1, 2, 10);   // normal: animate
  makeMove({ x: 800, y: 600 }, true)(1, 2, 10);
  assert.deepEqual(calls, ['setView', 'flyTo', 'setView']);
  // …and the map re-measures itself once it is actually shown.
  assert.match(html, /new ResizeObserver\(\(\) => map\.invalidateSize\(\)\)/);
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
  const place = extractFunction('placeDragPin');
  assert.doesNotMatch(place, /\.on\('add'/);
  assert.match(place, /getElement\(\)\.addEventListener\('keydown'/);

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
  assert.deepEqual(deleted.sort(), [
    'wxmap-v1.0.6',
    'wxmap-v3',
    'wxmap-weather-stations-v1.0.5',
    'wxmap-weather-stations-v1.0.7',
    'wxmap-weather-stations-v1.0.8',
    'wxmap-weather-stations-v1.1.0',
    'wxmap-weather-stations-v1.1.1',
    'wxmap-weather-stations-v1.1.2',
    'wxmap-weather-stations-v1.1.3'
  ]);

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
    `(activeAlertAreaOwner => (${extractFunction('openAlertPopupElement')})())`);
  assert.equal(openAlertPopupElement(null), null);
  const el = {};
  assert.equal(openAlertPopupElement({ getPopup: () => ({ getElement: () => el }) }), el);
  assert.doesNotMatch(extractFunction('handleAlertPopupClickAway') + extractFunction('handleAlertPopupEscape'),
    /querySelector/);
  assert.match(extractFunction('addAlertGeometryToMap'), /autoPan: true, autoPanPadding: \[16, 16\]/);

  // Keyboard users can open a station (Leaflet never maps Enter to a marker click)
  // and close the panel with Escape.
  const marker = extractFunction('makeStationMarker');
  assert.match(marker, /openStation\(id, name, iconEl\);[\s\S]*?popupCloseBtn\.focus\(\);/);
  assert.match(marker, /if \(!e\.repeat\) openFromKeyboard\(\);/);
  assert.match(marker, /addEventListener\('keyup', e => \{\s*if \(e\.key === ' '\)/);
  assert.match(html, /if \(e\.key === 'Enter' && e\.repeat\) e\.preventDefault\(\);/);
  // One Escape, one action: the alert popup handler skips a consumed key.
  assert.match(extractFunction('handleAlertPopupEscape'), /if \(event\.defaultPrevented\) return;/);
  assert.match(html, /popupPanel\.addEventListener\('keydown', e => \{\s*if \(e\.key !== 'Escape'\) return;/);

  assert.match(html, /\.weather-item-value \.na \{/);                 // the N/A span is a child
  assert.match(html, /#interval-input \{[^}]*font-size: 16px !important;/);   // no iOS zoom
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
});

test('Enter that confirms an IME composition does not start a search', () => {
  // Safari ends the composition before keydown, so keyCode 229 is checked too.
  assert.match(html, /e\.key === 'Enter' && !e\.isComposing && e\.keyCode !== 229\) doSearch\(\);/);
});

test('the alert banner stays clear of the map controls and the station panel', () => {
  // Desktop: above the bottom-left zoom control; beside an open panel in narrow windows.
  assert.match(html, /#alert-banner \{[^}]*max-height: max\(4rem, calc\(100% - 16px - 110px\)\);/);
  assert.match(html, /main\.sheet-open #alert-banner \{ max-width: calc\(100% - 16px - 314px - 32px\); \}/);
  // Phones: above the zoom control and Locate Me, full width even with the sheet open.
  assert.match(html, /max-height: max\(4rem, calc\(100% - 8px - 180px - var\(--safe-bottom\)\)\);/);
  // An open or hovered station inside a warning keeps readable dark text.
  assert.match(html, /\.station-marker\.alerted:hover,\s*\.station-marker\.alerted\.active \{ color: var\(--bg\); \}/);
  assert.match(html, /#fab-locate:focus-visible \{ outline: 2px solid var\(--text\);/);
  // A rebuilt banner keeps keyboard focus; the dead install-prompt hook is gone.
  const render = extractFunction('renderAlertBanner');
  assert.match(render, /if \(hadFocus\) alertBanner\.querySelector\('\[data-role="toggle"\]'\)\?\.focus\(\);/);
  assert.ok(render.indexOf('const hadFocus = alertBanner.contains(document.activeElement);') <
            render.lastIndexOf('alertBanner.innerHTML ='), 'focus must be checked before the rebuild');
  // Focus rings on the banner's buttons are drawn inside (the banner clips).
  assert.match(html, /\.alert-summary:focus-visible,\s*\.alert-card-head:focus-visible \{ outline: 2px solid var\(--text\); outline-offset: -3px; \}/);
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
  assert.match(extractFunction('renderAlertBanner'), /\.map\(unwrapAlertText\)/);
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
  const clickAway = new Function('openAlertPopupElement', 'map', 'alertAreaOwners', 'activeAlertAreaOwner', `
    ${extractFunction('handleAlertPopupClickAway')}
    return handleAlertPopupClickAway;
  `)(openAlertPopupElement, mapStub, alertAreaOwners, activeAlertAreaOwner);

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
  const place = extractFunction('placeDragPin');
  assert.match(place, /\(\{ lat, lng \} = L\.latLng\(lat, lng\)\.wrap\(\)\);/);
  assert.match(place, /getLatLng\(\)\.wrap\(\)/);
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
  const addressToCoords = vm.runInNewContext(`(async ${extractFunction('addressToCoords')})`, {
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
  assert.deepEqual({ ...await addressToCoords('paris tx', near) }, { lat: 33.66, lon: -95.55 });
  assert.match(requested[0], /^https:\/\/photon\.komoot\.io\/api\/\?q=paris%20tx&/);
  // Results are biased toward the map, or common names return no US match at all.
  // …but only coarsely (1 decimal, about 11 km): never the exact position.
  assert.match(requested[0], /&lat=39\.5&lon=-98\.[34]$/);

  features = [{ properties: { countrycode: 'FR' }, geometry: { coordinates: [2.35, 48.85] } }];
  await assert.rejects(addressToCoords('paris', near), /not found/);
});

test('station panel shows readings promptly and formats them cleanly', () => {
  const toFixedClean = vm.runInNewContext(
    html.match(/const toFixedClean = (\(n, digits\) => \{[\s\S]*?\n\});/)[1]);
  assert.equal(toFixedClean(-0.04, 1), '0.0', 'tiny negatives must not render as "-0.0"');
  assert.equal(toFixedClean(-1.25, 1), '-1.3');

  // The observation renders before the (slow, separate) forecast lookup finishes.
  const refresh = extractFunction('refreshStationData');
  assert.ok(refresh.indexOf('renderWeather(') < refresh.indexOf('await fetchForecastPoP'));
  assert.match(html, /const FORECAST_FAILURE_TTL_MS = 2 \* 60 \* 1000;/);

  // The refresh interval is clamped so setInterval can't overflow into a tight loop.
  assert.match(html, /id="interval-input"[\s\S]*?max="3600"/);
  assert.match(html, /const MAX_REFRESH_SECONDS = 3600;/);

  // Malformed station entries are skipped instead of aborting the whole plot.
  assert.match(extractFunction('plotStations'), /Number\.isFinite\(lat\)/);
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
