# WX.MAP — Weather Station Finder

A **Progressive Web App** for exploring real-time NOAA weather observation stations on an interactive map. Search by ZIP code, street address, or coordinates. Click any station to view live observations that refresh automatically.

---

## Table of Contents

1. [Features](#features)
2. [Getting Started](#getting-started)
3. [Search Methods](#search-methods)
4. [Draggable Pin](#draggable-pin)
5. [Locate Me Button](#locate-me-button)
6. [Weather Station Popup](#weather-station-popup)
7. [Dangerous-Weather Alerts](#dangerous-weather-alerts)
8. [URL Query Parameters](#url-query-parameters)
9. [Geocodio API Key](#geocodio-api-key)
10. [Progressive Web App (PWA)](#progressive-web-app-pwa)
11. [Architecture](#architecture)
12. [Data Sources & APIs](#data-sources--apis)
13. [Offline Support](#offline-support)
14. [Browser Compatibility](#browser-compatibility)

---

## Features

| Feature | Description |
|---|---|
| **Multi-mode search** | ZIP code, lat/lon coordinates, or street address |
| **Interactive map** | Leaflet.js + OpenStreetMap tiles, dark-mode filtered |
| **Station markers** | All nearby NOAA stations plotted as clickable badges |
| **Live observations** | Auto-refreshing weather data (configurable interval, ≥10 s) |
| **Dual temperature** | °F displayed prominently; °C shown alongside it |
| **Feels Like** | Heat Index or Wind Chill, whichever is applicable |
| **Precipitation chance** | Real next-hour probability of precipitation from the NWS gridded forecast |
| **Dangerous-weather alerts** | Active NWS watches/warnings/advisories for the area in a severity-ranked banner; each alert's footprint drawn on the map; a pulsing red ring on stations inside a warning polygon |
| **Alert map areas** | Every alert's area drawn as a uniquely-coloured polygon with an event label and a hover/tap popup (severity + in-effect time window) |
| **Sky conditions** | Cloud layer amount and base altitude |
| **Draggable pin** | Drop a pin anywhere on the map to search that location |
| **Locate Me FAB** | One-tap GPS location → instant station search |
| **Shareable URLs** | Every search updates the address bar — bookmark or share |
| **Geocodio address lookup** | Street-address geocoding; API key stored in the browser's localStorage |
| **PWA** | Installable, offline-capable, and self-updating via Service Worker |
| **Version badge** | Running app version shown in the bottom-left corner, reported live by the active Service Worker |

---

## Getting Started

WX.MAP needs **no build step and no backend**. The app is a small set of static files:

| File | Role |
|---|---|
| `index.html` | The entire app — markup, styles, and vanilla-JS logic |
| `sw.js` | Service worker — offline caching and update delivery |
| `manifest.json` | Web App Manifest — install metadata (name, icons, theme) |

1. Open `index.html` in any modern browser (Chrome, Firefox, Edge, Safari), **or**
2. For the full PWA experience (install, offline, auto-updates) serve the folder over HTTP/HTTPS — the service worker and manifest must be fetched over the network:

```bash
# Python 3 one-liner — run from the project folder
python3 -m http.server 8080
# then open http://localhost:8080/index.html
```

> **Note:** The Service Worker and Geolocation API require a **secure context** (HTTPS or `localhost`). Opening `index.html` directly via `file://` still gives you the map and search, but not Locate Me, install, or offline support.

---

## Search Methods

The search input in the header bar accepts three formats, detected automatically:

### 1. ZIP Code

Enter any US 5-digit ZIP code (optionally with the ZIP+4 extension):

```
78201
22201-1234
```

Geocoded via the **Nominatim / OpenStreetMap** API — no API key required.

### 2. Latitude / Longitude

Enter two comma-separated decimal numbers — latitude first, then longitude:

```
29.4241, -98.4936
38.8867, -77.0947
```

Valid ranges are **latitude −90 to 90** and **longitude −180 to 180**. Coordinates are parsed directly — no geocoding needed, so this is the fastest path. Out-of-range input is rejected instantly with a clear message, without making a network request.

### 3. Street Address

Enter any US street address:

```
1109 N Highland St, Arlington, VA
300 E Green St, Pasadena, CA
```

Geocoded via the **Geocodio API** (see [Geocodio API Key](#geocodio-api-key) below).

---

## Draggable Pin

The **📍 pin button** next to the search input lets you search by any map location without typing:

1. **Drag** the 📍 button from the header onto the map.
2. A ghost pin follows your cursor while dragging.
3. **Drop** it anywhere on the map — a labelled pin marker appears at that location.
4. The coordinates are automatically entered into the search field and nearby stations are fetched.

### Moving the pin

Once placed, the pin is **draggable on the map**. Drag it to a new spot and station search updates automatically.

### Removing the pin

| Method | Action |
|---|---|
| **Double-click** the dropped pin on the map | Removes the pin |
| Focus the **📍 header button** and press `Delete` or `Backspace` | Removes the pin |
| Focus the **dropped pin marker** (Tab to it) and press `Delete` or `Backspace` | Removes the pin |

---

## Locate Me Button

The **⊕ crosshair button** in the bottom-right corner of the map uses your device's GPS/location services:

1. Click the button — it pulses yellow while acquiring the position.
2. The browser prompts for location permission (first time only).
3. On success:
   - The map pans and zooms to your location.
   - A draggable search pin is dropped at your coordinates.
   - Nearby weather stations are fetched and plotted.

**Error handling:**

| Error | Message shown |
|---|---|
| Permission denied | "Location access denied. Please allow it in your browser settings." |
| Position unavailable | "Location unavailable. Check your device settings." |
| Timeout (>15 s) | "Location request timed out. Please try again." |

---

## Weather Station Popup

Click any station badge on the map to open the info panel. It shows:

| Field | Source |
|---|---|
| **Temperature** | °F (large) + °C (smaller, muted) side by side |
| **Conditions** | Text description (e.g. "Partly Cloudy") |
| **Dewpoint** | °F |
| **Humidity** | Relative humidity % |
| **Feels Like** | Heat Index *or* Wind Chill + °C companion (whichever applies) |
| **Wind** | Speed in mph + compass direction |
| **Gusts** | mph |
| **Visibility** | Miles |
| **Pressure** | Sea-level or barometric pressure in inHg |
| **Sky / Weather** | Cloud layer amount and base altitude in feet; present weather codes |
| **Precip Chance (next hr)** | Real probability of precipitation for the current hour, shown as % with a colour-gradient fill bar |

> **Humidity vs. Precip Chance — what's the difference?**
> **Humidity** is the relative-humidity reading taken straight from the station's latest observation. **Precip Chance** is a genuine *forecast* value, not derived from humidity. The latest-observation endpoint carries no probability-of-precipitation field, so WX.MAP resolves the station's coordinates to its NOAA forecast grid and reads the `probabilityOfPrecipitation` produced by the local Weather Forecast Office:
>
> 1. `GET /points/{lat},{lon}` → the station's `forecastHourly` grid URL.
> 2. `GET {forecastHourly}` → `periods[0].probabilityOfPrecipitation.value` (current hour).
>
> Because a forecast changes slowly, the result is **cached per station for 10 minutes** rather than re-fetched on every live-observation tick. The forecast fetch is best-effort: if it fails or is unavailable, the Precip Chance row is simply omitted and the rest of the observation still renders.

### Live refresh

The popup footer shows:
- **OBS:** the observation timestamp of the currently displayed data.
- **LIVE · [N] S** — the auto-refresh interval in seconds.

**To change the refresh interval:** click the number in the footer, type a new value (minimum 10 s), and press Enter or click away. The new interval takes effect immediately.

The pulsing dot indicates a refresh in progress; steady green means data is current. If an observation fetch fails the footer reads **Error fetching data**; when the *first* load fails the panel shows a brief "couldn't load — retrying" note rather than hanging on the loading state, and the next successful tick fills in the data.

### On mobile

On touch devices (and any window ≤ 640 px wide) the popup becomes a **bottom sheet**. Scroll its content freely; to dismiss it, swipe **down from the top of the sheet** (a swipe that starts mid-scroll just scrolls the content and won't close it — touch devices only), or tap the **✕** button.

---

## Dangerous-Weather Alerts

Every search also pulls the **active National Weather Service alerts** for that location — tornado and flash-flood warnings, severe-thunderstorm and winter-storm warnings, flood and tornado watches, heat advisories, and so on. They are fetched from the NWS [`/alerts/active`](https://api.weather.gov/alerts/active) endpoint, which returns only the alerts whose area contains the searched point.

> **Why alerts attach to the *area*, not a station.** The NWS never issues alerts for individual observation stations — it issues them for **polygons** (storm-based warnings) or **county/forecast zones** (most watches). WX.MAP therefore anchors alerts to the searched location and surfaces them in three complementary ways.

### Tier 1 — area alert banner

A banner floats at the top-left of the map whenever the area has active alerts (and stays hidden when it doesn't). The map's zoom control sits at the **bottom-left** so the banner never covers it, and the banner caps its own height and scrolls when many alerts are active. The banner lists every active alert, ranked **most-dangerous-first** and colour-coded:

| Class | Examples | Colour |
|---|---|---|
| **Critical** | Tornado Warning, Flash Flood Warning | 🔴 Red |
| **Warning** | any other Warning, or Extreme/Severe-rated alert | 🟠 Orange |
| **Watch** | Tornado Watch, Flood Watch, Severe T-storm Watch | 🟡 Amber |
| **Info** | Advisories, special statements | 🟡 Yellow |

The banner opens expanded; click the summary chip to collapse it, or click any alert to reveal its full headline, description, and the NWS safety **instructions**, along with the time it expires.

### Tier 2 — alert areas on the map

Every alert's geographic footprint is drawn directly on the map so you can see exactly where it applies:

- **Storm-based warnings** (tornado, severe-thunderstorm, flash-flood) carry an inline `Polygon`/`MultiPolygon` shape and are drawn immediately.
- **Zone-only products** (most watches and advisories) arrive with no inline shape but list `affectedZones` — WX.MAP resolves each zone's county/forecast outline and draws them as one merged area (so a multi-county watch gets a single label, not one per county). The zone lookup is best-effort and cached, so a slow or failed fetch never blocks the map.

Each area gets a **distinct colour** — hashed from the alert's id, so it stays stable across refreshes and overlapping areas remain easy to tell apart — and an **always-on label** naming the event. **Hover or tap** an area to open a popup with the event name, its **severity · urgency · certainty**, the **in-effect time window** (`onset → ends`, falling back to `effective → expires`), the headline, and the affected-area description; **clicking** pins the popup open.

### Tier 3 — per-station danger ring

Storm-based warnings (tornado, severe-thunderstorm, flash-flood) are issued as tight **polygons** that often cover only part of a city — so they can apply to some stations in the area but not others. WX.MAP runs a point-in-polygon test on every plotted station and gives any station **inside an active warning polygon** a **pulsing red ring**. Zone-only alerts have no storm polygon, so they get no ring — but they still appear as a map area (Tier 2) and in the banner.

### Refresh & resilience

Alerts move fast, so they are **re-fetched every 2 minutes** while a location stays loaded and **cached per coordinate for 2 minutes** to coalesce the refresh ticks into a single network call. Two refinements keep the experience stable:

- **No needless redraws.** Each refresh is compared (by alert id) against what's already on screen; if nothing has changed, the banner, map areas, and any open popup are left exactly as you left them — a banner you collapsed or a card you expanded is never reset out from under you on the next tick.
- **Failure-tolerant.** A timed-out or unreachable alert feed is treated as "temporarily unknown" rather than "no alerts", so the alerts currently on screen stay put and the next tick simply retries — a brief network hiccup never blanks an active warning. (On the very first load with no prior data, nothing is shown until the feed responds.)

---

## URL Query Parameters

Every search updates the page URL, making results **bookmarkable and shareable**.

| Parameter | Example | Description |
|---|---|---|
| `lat` + `long` | `?lat=29.4241&long=-98.4936` | Coordinate search |
| `zip` | `?zip=78201` | ZIP code search |
| `addr` | `?addr=300%20E%20Green%20St%2C%20Pasadena%2C%20CA` | Address search |
| `station` | `?station=KSAT` | Direct station lookup |

### `?station=KSAT`

When the `station` parameter is present:
1. The latest observation is fetched from the NOAA API.
2. The station's `geometry.coordinates` from the response is used to pan the map.
3. A station marker is plotted and the info popup opens immediately.
4. Live refresh starts automatically.
5. Active [dangerous-weather alerts](#dangerous-weather-alerts) for the station's location are loaded too — banner plus a danger ring on the marker if it sits inside a warning polygon.

This parameter takes priority over all others.

---

## Geocodio API Key

Street-address geocoding uses the [Geocodio API](https://www.geocod.io/), which requires a free API key.

### How it works

1. The first time you search by street address, a **modal dialog** appears.
2. Enter your Geocodio API key and click **Save & Continue**.
3. The key is saved in the browser's **localStorage** (`wxmap_geocodio_key`).
4. All future address searches use the stored key automatically — you won't be prompted again.

### Getting a key

Visit [geocod.io](https://www.geocod.io/) and sign up for a free account. The free tier includes 2,500 lookups per day.

### Key storage

- Stored **only in your browser**, in localStorage — it never leaves the device except in requests to Geocodio's geocoding endpoint.
- Unlike a cookie, localStorage is never attached to HTTP requests, so the key is not sent to the server hosting the app either. (Versions before 1.0.5 stored the key in a cookie; it is migrated to localStorage — and the cookie deleted — automatically on first use.)
- If the browser blocks localStorage (some WebViews and privacy modes), the key falls back to a cookie scoped to this app's directory so you still aren't re-prompted every session.
- Browser storage is **per-origin**: if the app is hosted on a shared origin (e.g. GitHub Pages project sites under `username.github.io`), other pages on that origin can technically access it. That was equally true of the old cookie — same-origin pages are never isolated from each other — so host the app on its own origin if strict key isolation matters.
- If Geocodio rejects the key (HTTP 403), it is cleared automatically and you are re-prompted on the next address search.
- To remove it manually, clear this page's site data (or run `localStorage.removeItem('wxmap_geocodio_key')` in the browser console).

---

## Progressive Web App (PWA)

WX.MAP ships a Web App Manifest (`manifest.json`) and a Service Worker (`sw.js`), making it installable, offline-capable, and self-updating.

### Installing

In a supporting browser (Chrome, Edge, Safari on iOS):
- **Desktop:** Click the install icon in the address bar, or go to browser menu → "Install WX.MAP".
- **Mobile:** Use "Add to Home Screen" from the browser share menu.

Once installed, the app opens in a standalone window without the browser chrome.

### Caching strategy

The service worker uses a hybrid strategy tuned for a single-file app:

| Request | Strategy | Why |
|---|---|---|
| HTML document (navigation) | **Network-first** | Always serves the latest `index.html` when online; offline it falls back to a single cached copy stored under one canonical key, so opening many bookmarked `?lat=…` links never bloats the cache. Only successful (2xx) responses are cached |
| Same-origin assets (`manifest.json`, …) | **Cache-first** | Instant loads; the cache is filled from the network on first fetch |
| Cross-origin (NOAA API, OSM tiles, Google Fonts, unpkg CDN) | **Pass-through** | Never cached — live data and third-party assets always go straight to the network |

Because the document is fetched network-first, a normal reload while online already pulls new code — even before the service-worker swap completes.

### Updates

WX.MAP is versioned by a single `APP_VERSION` constant that is woven into the service worker's cache name (`wxmap-v<version>`). Because bumping it changes `sw.js` itself, the browser is **guaranteed** to detect the new worker — even when a release only touches `index.html`. (Without this, a content-only deploy would be invisible to an installed standalone window until a cold relaunch.)

1. `sw.js` is registered with `updateViaCache: 'none'`, so the browser always byte-checks it against the network rather than trusting the HTTP cache.
2. The app re-checks for a new worker on a 30-minute timer **and every time it regains focus/visibility** (throttled to once a minute) — so reopening a long-lived installed PWA pulls any pending update promptly.
3. When a changed worker is found, it installs and **waits** — the running session is never disrupted mid-use.
4. An **"App update available"** banner slides down from the top with **REFRESH NOW** / **Dismiss**.
5. Accepting (or, in an installed/standalone window, a 5-second auto-apply) tells the waiting worker to take over; the page then reloads **once** into the new version.
6. Caches from previous versions are purged automatically on activation.

> **Releasing a new version:** bump `APP_VERSION` in `sw.js` (and the matching `APP_VERSION_FALLBACK` in `index.html`) so the update flow fires and the version badge reflects the new build.

### Version badge

A small **`vX.Y.Z`** badge sits in the **bottom-left corner** showing which build is running. The value is reported by the **active service worker** — the page requests it over a `GET_VERSION` message — so it flips to the new number the instant an update takes over, a visible confirmation that the update actually applied. Before any worker controls the page, a fallback constant is shown so the badge is never blank. The badge is click-through and sits just below the (lifted) map zoom control.

### Offline support

The app shell (`index.html`, `manifest.json`) is precached on first load, so the app opens instantly — even fully offline. Live weather data still requires a connection: NOAA and Nominatim requests are never cached and fail gracefully with an error toast when offline.

---

## Architecture

WX.MAP is a **zero-dependency, no-build app**. All UI and logic live in `index.html`; the PWA plumbing lives in two small sibling files (`sw.js`, `manifest.json`).

```
weather-stations/
├── index.html                      (the whole app)
│   ├── <head>
│   │   ├── <link rel="manifest">       → manifest.json
│   │   ├── inline SVG favicon + apple-touch-icon
│   │   ├── Google Fonts                (Space Mono, Syne — CDN)
│   │   └── Leaflet CSS                 (CDN)
│   ├── <body>
│   │   ├── Header                  (logo, search bar, status badge)
│   │   ├── #update-banner          (slides down when a new version is ready)
│   │   ├── #pin-ghost              (follows cursor during drag)
│   │   ├── <main>
│   │   │   ├── #map                (Leaflet map container — also holds alert area polygons)
│   │   │   ├── #map-overlay        (loading spinner)
│   │   │   ├── #alert-banner       (active NWS watches/warnings)
│   │   │   ├── #popup-panel        (station info / mobile bottom sheet)
│   │   │   └── #fab-locate         (GPS floating action button)
│   │   ├── #app-version           (bottom-left version badge)
│   │   ├── #toast                 (error / info notifications)
│   │   └── #modal-overlay         (Geocodio API key prompt)
│   └── <script>
│       ├── Leaflet JS              (CDN)
│       ├── SW registration + update flow + version badge
│       └── Application script      (vanilla JS)
│           ├── Map initialisation
│           ├── Application state
│           ├── UI helpers
│           ├── Refresh-interval editor
│           ├── Input-type detection
│           ├── Geocoding (ZIP / address)
│           ├── Cookie helpers
│           ├── Geocodio key modal
│           ├── NOAA Weather API
│           ├── Unit conversion
│           ├── Popup renderer
│           ├── Station refresh loop
│           ├── Panel open / close
│           ├── Marker management
│           ├── loadStationsAt pipeline
│           ├── Dangerous-weather alerts  (banner + map area polygons + per-station ring)
│           ├── URL helpers
│           ├── doSearch dispatcher
│           ├── Draggable pin
│           ├── Locate Me (Geolocation API)
│           ├── URL auto-trigger
│           └── Mobile enhancements (tap-to-place, bottom sheet)
├── sw.js                           (service worker — caching + updates)
└── manifest.json                   (Web App Manifest — install metadata)
```

---

## Data Sources & APIs

| Service | Purpose | Key required |
|---|---|---|
| [NOAA Weather.gov](https://api.weather.gov/) | Station list, live observations, hourly forecast (precip chance), active alerts, alert-area zone geometry | No |
| [Nominatim (OpenStreetMap)](https://nominatim.openstreetmap.org/) | ZIP → coordinates | No |
| [Geocodio](https://www.geocod.io/) | Street address → coordinates | Yes (free tier available) |
| [OpenStreetMap Tile Servers](https://tile.openstreetmap.org/) | Map tiles | No |
| [Browser Geolocation API](https://developer.mozilla.org/en-US/docs/Web/API/Geolocation_API) | Device GPS | User permission |

> **Resilience:** every network request (geocoding and weather) is capped by a **15-second timeout** — a slow or unreachable API aborts cleanly with an error toast instead of leaving the app stuck "loading". Rapid repeat searches are de-duplicated too, so a slow earlier request can never overwrite the results of a newer one.

---

## Offline Support

| Scenario | Behaviour |
|---|---|
| First visit (online) | App shell precached by the service worker |
| Repeat visit (online) | Latest `index.html` fetched network-first (cache refreshed); weather data fetched live |
| New version deployed | Update banner shown; applied on accept, or auto-applied in standalone — see [Updates](#updates) |
| Visit while offline | Shell served from cache; weather fetches fail gracefully with error toasts |
| `?station=` param offline | Station data fetch fails; error toast shown |

---

## Browser Compatibility

| Feature | Chrome | Firefox | Edge | Safari |
|---|---|---|---|---|
| Map + search | ✅ | ✅ | ✅ | ✅ |
| Draggable pin | ✅ | ✅ | ✅ | ✅ |
| Locate Me (GPS) | ✅* | ✅* | ✅* | ✅* |
| Service Worker (PWA) | ✅ | ✅ | ✅ | ✅ (iOS 16.4+) |
| Install prompt | ✅ | ✅ (manual) | ✅ | ✅ (Add to HS) |

\* Requires HTTPS or localhost. Denied in `file://` context on most browsers.
