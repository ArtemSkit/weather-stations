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
    URL,
    Set,
    console: { info() {}, warn() {} }
  });
  return listeners;
}

test('inline scripts compile and document IDs remain unique', () => {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1]);
  assert.equal(scripts.length, 2);
  scripts.forEach(script => new Function(script));

  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'duplicate HTML IDs break label and event targeting');
  const idSet = new Set(ids);
  for (const [, references] of html.matchAll(/\saria-(?:labelledby|describedby)="([^"]+)"/g)) {
    for (const id of references.split(/\s+/)) assert.ok(idSet.has(id), `missing ARIA target #${id}`);
  }
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
        'wxmap-v1.0.6',
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
    'wxmap-weather-stations-v1.0.5',
    'wxmap-weather-stations-v1.0.7'
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

  const licenseRequest = {
    method: 'GET', mode: 'navigate', url: 'https://example.test/weather/LEAFLET-LICENSE.txt'
  };
  await routed(licenseRequest);
  assert.ok(
    matchedRequests.includes(licenseRequest),
    'a direct license navigation must return the notice rather than the HTML app shell'
  );
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

test('alert popup selection toggles, switches areas, and closes on click-away or Escape', () => {
  let activePopup = null;
  let closeCount = 0;
  const documentStub = { querySelector: () => activePopup };
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
  const clickAway = new Function('document', 'map', 'alertAreaOwners', 'activeAlertAreaOwner', `
    ${extractFunction('handleAlertPopupClickAway')}
    return handleAlertPopupClickAway;
  `)(documentStub, mapStub, alertAreaOwners, activeAlertAreaOwner);

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

  const handleEscape = new Function('document', 'map', `
    ${extractFunction('handleAlertPopupEscape')}
    return handleAlertPopupEscape;
  `)(documentStub, mapStub);
  handleEscape({ key: 'Enter' });
  assert.equal(closeCount, 3);
  handleEscape({ key: 'Escape' });
  assert.equal(closeCount, 4);
  activePopup = null;
  handleEscape({ key: 'Escape' });
  assert.equal(closeCount, 4);

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

test('alert areas stack smaller footprints on top and use danger to break area ties', () => {
  const factory = new Function(`
    const ALERT_CLASS_RANK = { crit: 0, warn: 1, watch: 2, info: 3 };
    const ALERT_SEV_WEIGHT = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3, Unknown: 4 };
    const ALERT_URGENCY_WEIGHT = { Immediate: 0, Expected: 1, Future: 2, Past: 3, Unknown: 4 };
    const ALERT_CERTAINTY_WEIGHT = { Observed: 0, Likely: 1, Possible: 2, Unlikely: 3, Unknown: 4 };
    ${extractFunction('alertClass')}
    ${extractFunction('compareAlertDanger')}
    ${extractFunction('alertGeometryArea')}
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
    async ${extractFunction('fetchPointAlerts')}
    return { fetchPointAlerts };
  `)(async () => ({
    response: { ok: true, status: 200 },
    data: { features: [null, {}, { properties: null }, validAlert] }
  }));

  assert.deepEqual(await harness.fetchPointAlerts(29.4, -98.5), [validAlert]);
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

test('URL values use one standards-based encoding pass', () => {
  const values = ['300 E Green St, Pasadena, CA', '50% + rain & snow', 'Montréal'];
  for (const value of values) {
    const params = new URLSearchParams();
    params.set('addr', value);
    assert.equal(new URLSearchParams(params.toString()).get('addr'), value);
  }
  const pushQuery = extractFunction('pushQueryParam');
  const parseQuery = extractFunction('safeDecodeParam');
  assert.doesNotMatch(pushQuery, /encodeURIComponent/);
  assert.doesNotMatch(parseQuery, /decodeURIComponent/);
});

test('Geocodio persistence never writes a fallback cookie', () => {
  assert.doesNotMatch(html, /function setCookie\(/);
  const saveKey = extractFunction('saveStoredApiKey');
  assert.doesNotMatch(saveKey, /document\.cookie/);
  assert.doesNotMatch(saveKey, /setCookie/);
  assert.match(html, /type="password"[\s\S]*?id="modal-api-key"[\s\S]*?aria-label="Geocodio API key"/);
  assert.match(html, /#modal-api-key \{/);
  assert.match(html, /#modal-api-key:focus/);

  const keyPrompt = extractFunction('ensureGeocodioApiKey');
  assert.match(keyPrompt, /if \(apiKeyPromptPromise\) return apiKeyPromptPromise/);
  assert.match(keyPrompt, /cancelApiKeyPrompt = onCancel/);
  assert.match(extractFunction('addressToCoords'), /generation !== searchGeneration/);
});

test('every search path allocates or receives a generation before awaiting', () => {
  const search = extractFunction('doSearch');
  assert.ok(search.indexOf('const gen = ++searchGeneration') < search.indexOf('await zipToCoords'));
  assert.match(search, /loadStationsAt\(lat, lon, gen\)/);
  assert.match(search, /catch \(e\) \{\s*if \(gen !== searchGeneration\) return;/);

  const stationLoader = extractFunction('loadStationsAt');
  assert.match(stationLoader, /gen = \+\+searchGeneration/);
  assert.match(stationLoader, /if \(gen !== searchGeneration\) return/);

  const locateHandler = html.slice(html.indexOf("fabLocate.addEventListener('click'"));
  assert.ok(locateHandler.indexOf('const gen = ++searchGeneration') <
    locateHandler.indexOf('navigator.geolocation.getCurrentPosition'));
  assert.match(locateHandler, /fabLocate\.disabled = false;\s*if \(gen !== searchGeneration\) return;/);
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
    async ${extractFunction('refreshAlerts')}
    return { refreshAlerts, areaRenderCount: () => areaRenderCount };
  `)([{ id: 'watch-1' }]);

  await refreshHarness.refreshAlerts();
  assert.equal(refreshHarness.areaRenderCount(), 1);
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
