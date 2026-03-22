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
| **PWA** | Installable, offline-capable shell via Service Worker |

---

## Getting Started

WX.MAP is a **single HTML file** — no build step, no server, no installation required.

1. Download `weather-stations.html`.
2. Open it in any modern browser (Chrome, Firefox, Edge, Safari).
3. For full functionality, serve it over HTTP/HTTPS (required for Service Worker and Geolocation on some browsers):

```bash
# Python 3 one-liner
python3 -m http.server 8080
# then open http://localhost:8080/weather-stations.html
```

> **Note:** The Geolocation API and Service Worker require a **secure context** (HTTPS or localhost). Opening the file directly via `file://` will work for map and search features but not Locate Me or PWA install.

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

Enter two comma-separated decimal numbers:

```
29.4241, -98.4936
38.8867, -77.0947
```

Coordinates are parsed directly — no geocoding needed, so this is the fastest path.

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
- Never sent to anyone except Geocodio's geocoding endpoint.
- To remove it, clear your browser cookies for this page.

---

## Progressive Web App (PWA)

WX.MAP includes a Web App Manifest and a Service Worker, qualifying it as a PWA.

### Installing

In a supporting browser (Chrome, Edge, Safari on iOS):
- **Desktop:** Click the install icon in the address bar, or go to browser menu → "Install WX.MAP".
- **Mobile:** Use "Add to Home Screen" from the browser share menu.

Once installed, the app opens in a standalone window without the browser chrome.

### Offline support

The Service Worker caches the app shell on first load. Subsequent visits load instantly from cache even without a network connection. Live weather data requires an internet connection — network requests for the NOAA and Nominatim APIs are not cached.

---

## Architecture

WX.MAP is intentionally a **zero-dependency, single-file application** — everything lives in `weather-stations.html`.

```
weather-stations.html
├── <head>
│   ├── Web App Manifest       (inline data-URI)
│   ├── Google Fonts           (Space Mono, Syne)
│   └── Leaflet CSS            (CDN)
├── <body>
│   ├── Header                 (logo, search bar, status badge)
│   ├── Pin ghost              (follows cursor during drag)
│   ├── <main>
│   │   ├── #map               (Leaflet map container)
│   │   ├── #map-overlay       (loading spinner)
│   │   ├── #popup-panel       (station weather info)
│   │   └── #fab-locate        (GPS floating action button)
│   ├── #toast                 (error / info notifications)
│   └── #modal-overlay         (Geocodio API key prompt)
└── <script>
    ├── Leaflet JS             (CDN)
    └── Application script     (vanilla JS, ~600 lines)
        ├── Map initialisation
        ├── Application state
        ├── UI helpers
        ├── Refresh-interval editor
        ├── Input-type detection
        ├── Geocoding (ZIP/address)
        ├── Cookie helpers
        ├── Geocodio key modal
        ├── NOAA Weather API
        ├── Unit conversion
        ├── Popup renderer
        ├── Station refresh loop
        ├── Panel open / close
        ├── Marker management
        ├── loadStationsAt pipeline
        ├── URL helpers
        ├── doSearch dispatcher
        ├── Draggable pin
        ├── Locate Me (Geolocation API)
        ├── URL auto-trigger
        └── Service Worker registration
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

---

## Offline Support

| Scenario | Behaviour |
|---|---|
| First visit (online) | App shell cached by Service Worker |
| Repeat visit (online) | Shell loaded from cache; weather data fetched live |
| Visit while offline | Shell loads from cache; weather fetches fail gracefully with error toasts |
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
