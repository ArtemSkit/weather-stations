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
7. [URL Query Parameters](#url-query-parameters)
8. [Geocodio API Key](#geocodio-api-key)
9. [Progressive Web App (PWA)](#progressive-web-app-pwa)
10. [Architecture](#architecture)
11. [Data Sources & APIs](#data-sources--apis)
12. [Offline Support](#offline-support)
13. [Browser Compatibility](#browser-compatibility)

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
| **Precipitation estimate** | Heuristic % likelihood from humidity and dew-point spread |
| **Sky conditions** | Cloud layer amount and base altitude |
| **Draggable pin** | Drop a pin anywhere on the map to search that location |
| **Locate Me FAB** | One-tap GPS location → instant station search |
| **Shareable URLs** | Every search updates the address bar — bookmark or share |
| **Geocodio address lookup** | Street-address geocoding; API key stored in a browser cookie |
| **PWA** | Installable, offline-capable, and self-updating via Service Worker |

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
| **Precip Likelihood** | Estimated % with a colour-gradient fill bar |

### Live refresh

The popup footer shows:
- **OBS:** the observation timestamp of the currently displayed data.
- **LIVE · [N] S** — the auto-refresh interval in seconds.

**To change the refresh interval:** click the number in the footer, type a new value (minimum 10 s), and press Enter or click away. The new interval takes effect immediately.

The pulsing dot indicates a refresh in progress; steady green means data is current.

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

This parameter takes priority over all others.

---

## Geocodio API Key

Street-address geocoding uses the [Geocodio API](https://www.geocod.io/), which requires a free API key.

### How it works

1. The first time you search by street address, a **modal dialog** appears.
2. Enter your Geocodio API key and click **Save & Continue**.
3. The key is saved in a **browser cookie** (`wxmap_geocodio_key`, 1-year expiry).
4. All future address searches use the stored key automatically — you won't be prompted again.

### Getting a key

Visit [geocod.io](https://www.geocod.io/) and sign up for a free account. The free tier includes 2,500 lookups per day.

### Key storage

- Stored **only in your browser** as a cookie.
- The cookie is scoped to this app's own path, so other sites sharing the same host (e.g. other GitHub Pages projects) never receive it.
- Never sent to anyone except Geocodio's geocoding endpoint.
- To remove it, clear your browser cookies for this page.

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
| HTML document (navigation) | **Network-first** | Always serves the latest `index.html` when online; falls back to the cached copy offline |
| Same-origin assets (`manifest.json`, …) | **Cache-first** | Instant loads; the cache is filled from the network on first fetch |
| Cross-origin (NOAA API, OSM tiles, Google Fonts, unpkg CDN) | **Pass-through** | Never cached — live data and third-party assets always go straight to the network |

Because the document is fetched network-first, a normal reload while online already pulls new code — even before the service-worker swap completes.

### Updates

WX.MAP detects and applies new versions reliably:

1. The browser re-checks `sw.js` on each navigation and every 30 minutes.
2. When a changed worker is found, it installs and **waits** — the running session is never disrupted mid-use.
3. An **"App update available"** banner slides down from the top with **REFRESH NOW** / **Dismiss**.
4. Accepting (or, in an installed/standalone window, a 5-second auto-apply) tells the waiting worker to take over; the page then reloads **once** into the new version.
5. Caches from previous versions are purged automatically on activation.

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
│   │   │   ├── #map                (Leaflet map container)
│   │   │   ├── #map-overlay        (loading spinner)
│   │   │   ├── #popup-panel        (station info / mobile bottom sheet)
│   │   │   └── #fab-locate         (GPS floating action button)
│   │   ├── #toast                 (error / info notifications)
│   │   └── #modal-overlay         (Geocodio API key prompt)
│   └── <script>
│       ├── Leaflet JS              (CDN)
│       ├── SW registration + update flow
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
| [NOAA Weather.gov](https://api.weather.gov/) | Station list, live observations | No |
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
