# WX.MAP — Weather Station Finder

A **Progressive Web App** for exploring real-time NOAA weather observation stations on an interactive map. Search by ZIP code, street address, or coordinates. Click any station to view live observations that refresh automatically.

---

## Table of Contents

1. [Features](#features)
2. [Getting Started](#getting-started)
3. [Search Methods](#search-methods)
4. [Draggable Pin](#draggable-pin)
5. [Locate Me Button](#locate-me-button)
6. [Search Circle](#search-circle)
7. [Forecast](#forecast)
8. [Weather Station Popup](#weather-station-popup)
9. [Dangerous-Weather Alerts](#dangerous-weather-alerts)
10. [URL Query Parameters](#url-query-parameters)
11. [Progressive Web App (PWA)](#progressive-web-app-pwa)
12. [Architecture](#architecture)
13. [Data Sources & APIs](#data-sources--apis)
14. [Offline Support](#offline-support)
15. [Quality Checks](#quality-checks)
16. [Browser Compatibility](#browser-compatibility)

---

## Features

| Feature | Description |
|---|---|
| **Multi-mode search** | ZIP code, lat/lon coordinates, or street address |
| **Interactive map** | Leaflet.js + OpenStreetMap tiles, dark-mode filtered |
| **Station markers** | The NOAA stations near the searched point (about 50 mi, or the nearest 8), plotted as clickable badges |
| **Search circle** | A glowing circle marks the searched area and labels it ("8 stations · within 41 mi"); the **RADIUS** button hides it for the plain map |
| **Live observations** | Auto-refreshing weather data (configurable interval, 10 s – 1 h; paused while the app is in the background) |
| **Dual temperature** | °F displayed prominently; °C shown alongside it |
| **Feels Like** | Heat Index or Wind Chill, whichever is applicable |
| **Precipitation chance** | Real probability of precipitation for the current hour, from the NWS gridded forecast |
| **Dangerous-weather alerts** | Active NWS watches/warnings/advisories for the area in a severity-ranked banner; each alert's footprint drawn on the map; a pulsing red ring on stations inside a warning polygon |
| **Alert map areas** | Every alert's area drawn as a uniquely-coloured polygon with an event label and a click/tap popup (severity + in-effect time window) |
| **Live alerts** | One button shows every watch, warning and advisory in the map view, in the NWS map colours, and keeps adding new ones as you pan or zoom |
| **Forecast** | The **FORECAST** button shows the National Weather Service 7-day and hourly forecast for the searched area |
| **Sky conditions** | Cloud layer amount and base altitude |
| **Draggable pin** | Drop a pin anywhere on the map to search that location |
| **Locate Me FAB** | One-tap GPS location → instant station search |
| **Shareable URLs** | Every successful search updates the address bar — bookmark or share |
| **Address lookup** | Free, typo-tolerant street-address geocoding via Photon — no API key or sign-up |
| **PWA** | Installable and offline-capable, with user-controlled updates via Service Worker |
| **Version badge** | Running app version shown in the bottom-left corner, reported live by the active Service Worker; tap it to open this GitHub repository |

---

## Getting Started

WX.MAP needs **no build step and no backend**. Leaflet is vendored at a pinned
version so the map shell has no runtime CDN dependency:

| File | Role |
|---|---|
| `index.html` | The entire app — markup, styles, and vanilla-JS logic |
| `sw.js` | Service worker — offline caching and update delivery |
| `manifest.json` | Web App Manifest — install metadata (name, icons, theme) |
| `leaflet.js` / `leaflet.css` / `leaflet.js.map` / `images/` | Vendored Leaflet 1.9.4 runtime, styles, debug map, and referenced UI images |
| [`LEAFLET-LICENSE.txt`](./LEAFLET-LICENSE.txt) | Leaflet's BSD 2-Clause license, shipped with online and offline copies |
| `tests/quality.test.mjs` | Dependency-free regression and service-worker behavior checks |

1. Open `index.html` in any modern browser (Chrome, Firefox, Edge, Safari), **or**
2. For the full PWA experience (install, offline, update delivery) serve the folder over HTTP/HTTPS — the service worker and manifest must be fetched over the network:

```bash
# Run from the project folder (use whichever Python launcher your OS provides)
python -m http.server 8080
# or: python3 -m http.server 8080
# or on Windows: py -m http.server 8080
# then open http://localhost:8080/index.html
```

> **Note:** The Service Worker and Geolocation API require a **secure context** (HTTPS or `localhost`). Opening `index.html` directly via `file://` still gives you the map and search, but not Locate Me, install, or offline support.

---

## Search Methods

The search input in the header bar accepts three formats, detected automatically:

### 1. ZIP Code

Enter any US 5-digit ZIP code (optionally with the ZIP+4 extension, after a hyphen, a space, or nothing):

```
78201
22201-1234
```

Any other all-digit entry (e.g. a 4-digit typo) is reported as an invalid ZIP rather than searched as an address.

Geocoded via the **Nominatim / OpenStreetMap** API — no API key required. If Nominatim can't be reached, the ZIP is looked up in Photon's postcode index instead.

### 2. Latitude / Longitude

Enter two decimal numbers separated by a comma or a space — latitude first, then longitude:

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

Geocoded via **[Photon](https://photon.komoot.io/)**, a free OpenStreetMap geocoder — no API key required. Photon tolerates typos and missing punctuation (`1109 n highlnd st arlington va` still finds the right building). It searches worldwide, so WX.MAP biases results toward the area currently on the map and takes the best match inside the US (including US territories), since NOAA data covers only the US.

> **Fair use:** the public Photon server is free but has no uptime guarantee and throttles heavy use. That suits one-search-at-a-time traffic like this app's. If it ever becomes a problem, Photon is open source and can be self-hosted.

> **Upgrading from 1.0.x:** older releases asked for a Geocodio API key and stored it in the browser. That key is no longer used, and 1.1.0 deletes any stored copy (localStorage and legacy cookie) on startup.

---

## Draggable Pin

The **📍 pin button** next to the search input lets you search by any map location without typing:

1. **Drag** the 📍 button from the header onto the map.
2. A ghost pin follows your cursor while dragging.
3. **Drop** it anywhere on the map — a labelled pin marker appears at that location. Pressing `Esc` mid-drag cancels it.
4. The coordinates are automatically entered into the search field and nearby stations are fetched.

### Tap or click to place

Dragging isn't possible on touch screens or from a keyboard, so the pin also works without it:

1. **Click** the 📍 button (or focus it and press `Enter`/`Space`). On touch devices, **tap** the 📍 button that replaces it.
2. A banner across the top of the map confirms the mode is on.
3. **Tap or click** anywhere on the map — even on an alert area or a station — to place the pin there. From the keyboard, focus the map, pan with the arrow keys, and press `Enter` to place the pin at the map's centre.
4. Press the 📍 button again, or `Esc`, to cancel. Starting a typed search also turns the mode off.

On touch devices (and any window ≤ 640 px wide), where the station panel is a bottom sheet, turning the mode on closes the panel, so there is map left to tap; open the station again afterwards if needed.

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
   - A draggable search pin is dropped at your coordinates, rounded to about 110 m — close enough to find nearby stations, without writing your exact GPS position into the address bar, history or shared links.
   - Nearby weather stations are fetched and plotted.

**Error handling:**

| Error | Message shown |
|---|---|
| Permission denied | "Location access denied. Please allow it in your browser settings." |
| Page opened over plain `http://` (not localhost) | "Locate Me needs the app to be opened over HTTPS (or localhost)." — browsers only share location with secure pages |
| Position unavailable | "Location unavailable. Check your device settings." |
| Timeout (>15 s) | "Location request timed out. Please try again." |
| No answer at all (e.g. the permission prompt was dismissed) | "No location received. Please try again." — after 60 s the button and map are released; a location that still arrives later is used |

---

## Search Circle

NOAA's station list for a location covers its whole forecast area — often 150–230 miles across, and over 1,000 miles in Alaska — far more than fits on screen. So every search (ZIP, address, coordinates, a dropped pin, Locate Me, or a shared link) shows only the stations near the searched point:

- about every station **within 50 miles**, or the **nearest 8** when fewer are that close;
- the circle's edge is placed where it has room: just clear of the last station shown, by a marker's width **as drawn on your screen**. Stations often come in tight clusters, so to find such a gap the edge may move up to 25% further out or 30% further in (never below the nearest 8); the stations left out aren't drawn, so the edge may sit right next to the first of them. Where stations are too dense for any gap that wide, it takes the widest one available. Every station inside the edge is always shown, so the label's distance is true.

A **glowing circle** marks that area, with a label such as **"8 stations · within 41 mi"**. Nothing is drawn inside the circle; the glow, a slowly turning dotted ring and a gentle dimming of the map are all **outside** it. The map zooms in to fit the circle — but never zooms **out** for it: if you are already zoomed in closer (say, Locate Me while looking at a few streets), the map keeps your zoom and just moves to the spot. The circle grows out from the searched point (instantly when the system asks for reduced motion). A direct `?station=` link shows just that station, without a circle.

The **RADIUS** button next to LIVE ALERTS (shown while a circle is drawn) turns the circle, its glow, the dimming and the label off to see the plain map — the stations stay — and on again. The choice is remembered on that device for later searches.

---

## Forecast

Once an area is loaded, a **FORECAST** button appears in the header. It opens the National Weather Service forecast for the searched point (or, for a `?station=` link, the station's spot):

- **7 DAYS** — the forecaster's day and night periods ("Tonight", "Friday", "Friday Night", …) with the temperature in °F and °C, the sky and chance of rain in words, the chance of rain and the wind. Tap a period for the full wording ("A slight chance of showers and thunderstorms between 10pm and 1am…").
- **HOURLY** — the next 48 hours, grouped by day: temperature, chance of rain, sky and wind. Times are the searched place's own clock, even when it is in another time zone than your device.

It comes straight from the NWS (free, no key): `/points/{lat},{lon}` names the forecast grid cell, and its two forecast links (only ever NOAA's own) are fetched. A forecast is reused for 10 minutes; when the NWS forecast service hiccups (it sometimes answers an error for a minute or two), a **Try again** button reloads it. On phones it opens as a sheet from the bottom of the screen; Esc, the ✕ or a tap outside closes it.

---

## Weather Station Popup

Click any station badge on the map — or focus it with `Tab` and press `Enter` — to open the info panel (opening it from the keyboard moves focus into it; with focus in the panel, `Esc` closes it and returns focus to the badge — otherwise use its ✕). It shows:

| Field | Source |
|---|---|
| **Temperature** | °F (large) + °C (smaller, muted) side by side, in whole degrees like weather.gov |
| **Conditions** | Text description (e.g. "Partly Cloudy") |
| **Dewpoint** | °F |
| **Humidity** | Relative humidity % |
| **Feels Like** | Heat Index (from 80°F) *or* Wind Chill (50°F or colder with wind of 3 mph or more) + °C companion — hidden otherwise, even if NOAA sends a value |
| **Wind** | Speed in whole mph + compass direction, or **Calm** |
| **Gusts** | mph — or "None" when the wind isn't gusting (stations only report gusts while it gusts). The 5-minute reports sometimes leave a gust out even then, so a gust from the station's last 15 minutes stays shown, with its age ("5 min ago") |
| **Visibility** | Miles, as US reports give them — fractions (0.25, 0.75…) below 3 mi, whole or half miles above |
| **Pressure** | Altimeter setting (the "barometer" reading US reports use) in inHg; sea-level pressure only if that is missing |
| **Sky / Weather** | Total sky cover — the layer with the most cover and its base, to the nearest 100 ft (no height for a clear sky; *Obscured* with the vertical visibility when fog or snow hides the sky) — plus present weather in words when it adds to the description |
| **Precip Chance (this hr)** | Real probability of precipitation for the current hour, shown as % with a colour-gradient fill bar |

> **Humidity vs. Precip Chance — what's the difference?**
> **Humidity** is the relative-humidity reading taken straight from the station's latest observation. **Precip Chance** is a genuine *forecast* value, not derived from humidity. The latest-observation endpoint carries no probability-of-precipitation field, so WX.MAP resolves the station's coordinates to its NOAA forecast grid and reads the `probabilityOfPrecipitation` produced by the local Weather Forecast Office:
>
> 1. `GET /points/{lat},{lon}` → the station's `forecastHourly` grid URL.
> 2. `GET {forecastHourly}` → `probabilityOfPrecipitation.value` of the hour in progress (the first period that hasn't ended — a forecast issued a while ago still starts with a finished hour).
>
> Because a forecast changes slowly, the result is **cached per station for up to 10 minutes** (never past the end of the hour it describes) rather than re-fetched on every live-observation tick. The forecast fetch is best-effort and never delays the observation: the readings appear as soon as they arrive, and the Precip Chance row is added once the forecast answers. If it is unavailable, the row is simply omitted. A failed lookup is retried after 2 minutes; meanwhile a value already shown for the current hour stays (otherwise the row is omitted).

### Live refresh

The popup footer shows:
- **OBS:** the observation timestamp of the currently displayed data, in your own time zone (labelled, e.g. "CDT"). It gains the date when it isn't from today and an age ("5 h old") once it is 2 hours old or more, since a station's "latest" report can be days old.
- **LIVE · [N] S** — the auto-refresh interval in seconds.

**To change the refresh interval:** click the number in the footer, type a new value (10–3600 s), and press Enter or click away. The new interval takes effect immediately. While the tab or installed app is hidden, refreshes pause; the panel catches up as soon as it is visible again.

The pulsing dot indicates a refresh in progress; steady green means data is current. If a refresh fails the dot turns red and the footer keeps the shown reading's time with **· update failed** after it (or reads **Error fetching data** if nothing has loaded yet); when the *first* load fails the panel shows a brief "couldn't load — retrying" note rather than hanging on the loading state, and the next successful tick fills in the data. A listed station with no recent observations (NOAA answers 404 on the first load) says so instead and is not polled (the LIVE interval is hidden).

### On mobile

On touch devices (and any window ≤ 640 px wide) the popup becomes a **bottom sheet**. Scroll its content freely; to dismiss it, swipe **down from the top of the sheet** (a swipe that starts mid-scroll just scrolls the content and won't close it — touch devices only), or tap the **✕** button.

---

## Dangerous-Weather Alerts

Every search pulls the **active National Weather Service alerts** that contain the searched point — tornado and flash-flood warnings, severe-thunderstorm and winter-storm warnings, flood and tornado watches, heat advisories, and so on. It also adds nearby same-state alerts with inline polygons when their filled footprints intersect the search circle's area. WX.MAP combines the NWS point feed with a cached state alert index: the point feed preserves relevant zone-only products, while the state feed contributes only visible inline polygons rather than loading every unrelated zone in the state.

> **Why alerts attach to the *area*, not a station.** The NWS never issues alerts for individual observation stations — it issues them for **polygons** (storm-based warnings) or **county/forecast zones** (most watches). WX.MAP therefore anchors alerts to the searched point and the search circle's area, then surfaces them in three complementary ways — and the **Live alerts** button shows every alert in the map view on demand.

### Tier 1 — area alert banner

A banner floats at the top-left of the map whenever the searched point or the visible same-state map area has active alerts (and stays hidden when neither does). The map's zoom control sits at the **bottom-left**, and the banner caps its own height (scrolling when many alerts are active) so it stays clear of the zoom control and the Locate Me button — except when very little map is visible (a very short screen, or a tall station sheet open on a phone). Then keeping the alert summary visible wins; with a phone's station sheet open, the Locate Me button is drawn on top of the banner so it stays tappable. The banner lists every included alert, ranked **most-dangerous-first** and colour-coded:

| Class | Examples | Colour |
|---|---|---|
| **Critical** | Tornado Warning, Flash Flood Warning | 🔴 Red |
| **Warning** | any other Warning, or an Extreme/Severe-rated alert that is not a watch | 🟠 Orange |
| **Watch** | Tornado Watch, Flood Watch, Severe T-storm Watch | 🟡 Amber |
| **Info** | Advisories, special statements | 🟡 Yellow |

Each alert says **where** it applies — the first few places on its header ("Pima · Pinal · Maricopa +5 more"), all of them when opened — and opening it offers **📍 Show this area on the map** at the top, which zooms to that one alert's own area (say, the Orange County inland zone of an Extreme Heat Warning) and then picks it out for a few seconds — a soft glow and a slowly moving dashed outline along its edge, one brief flash inside and its name in a chip — before it fades away (a click on the map dismisses it sooner). Alerts of one type are **grouped** into a single row ("Extreme Heat Warning ×8", with their places and shared time) that opens to the individual alerts, so a long run of one type can't push the others out of sight. When the list is longer than the banner, a **"▾ More alerts below"** bar sits at its bottom edge until you scroll to the end. What you opened stays open when the list refreshes.

The banner opens expanded; click the summary chip to collapse it — it then stays collapsed through refreshes, new searches and reloads until you expand it again — or click any alert to reveal its full headline, description, and the NWS safety **instructions**, along with when the hazard ends (the same end time the map popup shows). An alert that hasn't started yet also shows when it begins ("from … until …"), and a warning, watch or advisory with no set end says "until further notice" rather than quoting when the message itself lapses (a short statement without one shows when it lapses). All times are shown in your own time zone; the NWS headline text keeps the issuing office's zone.

### Tier 2 — alert areas on the map

Every alert's geographic footprint is drawn directly on the map so you can see exactly where it applies:

- **Storm-based warnings** (tornado, severe-thunderstorm, flash-flood) carry an inline `Polygon`/`MultiPolygon` shape and are drawn immediately.
- **Zone-only products** (most watches and advisories) arrive with no inline shape but list `affectedZones` — WX.MAP resolves each zone's county/forecast outline and draws them as one merged area (so a multi-county watch gets a single label, not one per county). The zone lookup is best-effort and cached, so a slow or failed fetch never blocks the map.

Each area gets a **distinct colour** — hashed from the alert's id, so it stays stable across refreshes and overlapping areas remain easy to tell apart — and an **always-on label** naming the event. At overlaps, the smaller, more geographically specific footprint is placed on top and receives the click; equal-size footprints use danger priority as the tie-breaker. **Click or tap** an area to open a popup with the event name, its **severity · urgency · certainty**, the **in-effect time window** (from `onset`, else `effective`; to the same end time as the banner), the headline, and the affected-area description. Clicking the same area again closes its popup; clicking a different area replaces it immediately with that area's popup at the new click location. The × button, Escape, and a click on the map outside every alert area also close it.

### Tier 3 — per-station danger ring

Storm-based warnings (tornado, severe-thunderstorm, flash-flood) are issued as tight **polygons** that often cover only part of a city — so they can apply to some stations in the area but not others. WX.MAP runs a point-in-polygon test on every plotted station and gives any station **inside an active warning polygon** a **pulsing red ring**. Zone-only alerts have no storm polygon, so they get no ring — but they still appear as a map area (Tier 2) and in the banner.

### Live alerts — everything in the map view

The **LIVE ALERTS** button above the zoom buttons turns on live tracking of every active watch, warning and advisory **inside the visible map** — anywhere in the country, not just around the searched place. Pan or zoom and the areas that come into view are added; areas already drawn stay. The button shows how many alerts are in view ("…" while loading — also right after a pan, until that view's answer is in — "!" when the alert service can't be reached — it retries on its own; it never shows a misleading "0"); **KEY** opens a colour key listing each alert type in view with its count, and clicking a type hides or shows its areas.

The small **‹** button at the start of that row folds LIVE ALERTS, KEY and RADIUS away to keep the map clear (tap **›** to bring them back). Everything keeps working while folded — a red dot on the button shows live alerts are still on — and the choice is remembered on that device.

- **Colours** follow the National Weather Service's own hazard map (Tornado Warning red, Flood Warning green, Winter Storm Warning pink, and so on), so they mean what forecasters intend. Warnings are drawn on top of watches and advisories.
- **Hover** an area to highlight every county of that alert; **click or tap** it for the same popup as the searched area's alerts (event, severity, time window, headline, affected areas), loaded from the alert's NWS record. Escape, a click elsewhere or a second click on the same alert closes it. (The live areas are drawn on one fast canvas, so they can't be reached with `Tab`; the alert banner lists the searched place's alerts for keyboard and screen-reader users.)
- **One request per view.** The outlines come from NOAA's watch/warning/advisory map service, which returns every alert area inside the view in a single request, already simplified for the zoom level (the whole country is about 600 KB). A view that crosses the date line (Alaska with the western Aleutians and the Bering Sea) is asked for in two parts, and outlines that cross the date line are joined up and drawn next to the view you're looking at (a zone the service splits at the date line is drawn once, not twice). The set is re-checked every **2 minutes** (paused while the app is in the background), and areas whose hazard has ended are removed (by the hazard's end time, not the message's — a warning, watch or advisory without one lasts "until further notice", until the service drops it; a brief empty answer from the service is double-checked before anything is cleared). Areas left on another copy of the world after a long pan are let go.
- **Labels.** Each live alert in view gets a name chip ("FLOOD", "HEAT"), like the searched area's own areas: one per alert, the most serious first, and never on top of another chip, the alert banner, an open station panel or the search circle's label (so a zoomed-out view shows the main ones, up to 30).
- **The banner follows the view.** While live alerts are on, the alert banner lists the alerts drawn in the map view ("28 alerts in view · …") and updates as you pan or zoom, without a new search; each alert's places and full NWS text come from its NWS record, loaded in the background (a few at a time) while the list is open. Switching live alerts off brings back the searched place's own alerts.
- While live alerts are on, the searched area's own alert areas (Tier 2) are hidden so nothing is drawn twice; the station rings (Tier 3) still describe the searched place. In pin mode, tapping an alert area places the pin as usual.

### Refresh & resilience

Alerts move fast, so they are **re-fetched every 2 minutes** while a location stays loaded (paused while the app is in the background, with an immediate catch-up when it returns). Point feeds are cached per coordinate and regional feeds per state for 90 seconds — short enough that every 2-minute tick gets fresh data, long enough to share one request between overlapping lookups. NWS test and exercise messages are filtered out, and so are cancellation notices (which NWS keeps in its "active" feed under the original event name until the original end time), so only alerts actually in force are shown. Two refinements keep the experience stable:

- **No needless redraws.** Each refresh is compared (by alert id) against what's already on screen; if nothing has changed, the banner, map areas, and any open popup are left exactly as you left them — a banner you collapsed or a card you expanded is never reset out from under you on the next tick.
- **Failure-tolerant.** A timed-out or unreachable alert feed is treated as "temporarily unknown" rather than "no alerts", so the alerts currently on screen stay put and the next tick simply retries — a brief network hiccup never blanks an active warning. During a longer outage, an alert is still removed once its own end time has passed. (On the very first load with no prior data, nothing is shown until the feed responds.) A search that fails before loading new stations (unknown ZIP or address, denied location) leaves the current area — and its alerts — in place, even one that is still loading; the toast explains the error while the status bar keeps describing that area (still loading, then its station count — or its own error if it fails).

---

## URL Query Parameters

Every successful search updates the page URL, making results **bookmarkable and shareable**. Input that can't be resolved (invalid coordinates, unknown ZIP or address) leaves the URL — and the area on the map — unchanged. A link with non-numeric `lat`/`long` shows an error instead of being treated as an address, and `station` ids are trimmed and upper-cased.

| Parameter | Example | Description |
|---|---|---|
| `lat` + `long` | `?lat=29.4241&long=-98.4936` | Coordinate search |
| `zip` | `?zip=78201` | ZIP code search |
| `addr` | `?addr=300%20E%20Green%20St%2C%20Pasadena%2C%20CA` | Address search |
| `station` | `?station=KSAT` | Direct station lookup |

### `?station=KSAT`

When the `station` parameter is present:
1. The latest observation and the station's own record are fetched from the NOAA API together.
2. The station record's exact location is used to pan the map and place the marker (the observation's location is rounded, sometimes ~2 km off, and is only a fallback).
3. A station marker is plotted and the info popup opens immediately.
4. Live refresh starts automatically.
5. Active [dangerous-weather alerts](#dangerous-weather-alerts) for the station's location are loaded too — banner plus a danger ring on the marker if it sits inside a warning polygon.

This parameter takes priority over all others.

---

## Progressive Web App (PWA)

WX.MAP ships a Web App Manifest (`manifest.json`) and a Service Worker (`sw.js`), making it installable and offline-capable with user-controlled update delivery.

### Installing

In a supporting browser (Chrome, Edge, Safari on iOS):
- **Desktop:** Click the install icon in the address bar, or go to browser menu → "Install WX.MAP".
- **Mobile:** Use "Add to Home Screen" from the browser share menu.

Once installed, the app opens in a standalone window without the browser chrome.

> **Hosting note:** the manifest's `"id": "./"` resolves to the site's origin root (the spec resolves `id` against the origin, not the folder). Host WX.MAP on its own origin — not as one of several apps under, say, `username.github.io/…` — or another installed app on that origin with the same id would be treated as the same app. Changing the id later makes existing installs count as a different app, so it is kept stable.

### Caching strategy

The service worker uses a hybrid strategy tuned for a single-file app:

| Request | Strategy | Why |
|---|---|---|
| HTML document (navigation to `index.html` or the app folder) | **App-shell cache** | Keeps `index.html` on the same installed release as its Leaflet code/styles; bookmarked `?lat=…` links all use the one canonical cached document. Navigations to any other page go to the network. |
| Declared same-origin shell assets (`manifest.json`, vendored Leaflet, license notice) | **Cache-first** | Required map code, styles, and third-party notice are installed atomically with the document |
| Other same-origin requests | **Pass-through** | Future dynamic or private responses cannot be cached accidentally |
| Cross-origin (NOAA API, OSM tiles, Google Fonts) | **Pass-through** | Never cached — live data and third-party assets always go straight to the network |

The first uncontrolled visit uses the network. Once installed, a release stays internally consistent until its complete replacement shell is ready and the user accepts it.

### Updates

WX.MAP is versioned by a single `APP_VERSION` constant that is woven into the service worker's cache name (`wxmap-weather-stations-v<version>`). Because bumping it changes `sw.js` itself, the browser detects the new worker even when a release only touches `index.html`.

1. `sw.js` is registered with `updateViaCache: 'none'`, so the browser always byte-checks it against the network rather than trusting the HTTP cache.
2. The app re-checks for a new worker on a 30-minute timer **and every time it regains focus/visibility** (throttled to once a minute) — so reopening a long-lived installed PWA pulls any pending update promptly.
3. The complete shell is precached atomically. If any required file is unavailable, installation fails and the last known-good release remains active.
4. When a changed worker is ready, it **waits** — the running session is never disrupted mid-use.
5. An **"App update available"** banner slides down from the top with **REFRESH NOW** / **Dismiss**.
6. **REFRESH NOW** tells the waiting worker to take over and reloads once. **Dismiss** leaves the current interaction and release untouched. Accepting the update in one window reloads every other open WX.MAP window that was running the old release, because they all switch to the new release together. (A window opened with a hard reload — `Ctrl+Shift+R` — already loaded straight from the network, so it only reloads when you accept the update in that window.)
7. Caches from previous WX.MAP versions are purged automatically on activation; unrelated same-origin caches are left alone.

> **Releasing a new version:** bump `APP_VERSION` in `sw.js` (and the matching `APP_VERSION_FALLBACK` in `index.html`) so the update flow fires and the version badge reflects the new build.

### Version badge

A small **`vX.Y.Z`** badge sits in the **bottom-left corner** showing which build is running. The value is reported by the **active service worker** — the page requests it over a `GET_VERSION` message — so it flips to the new number the instant an update takes over, a visible confirmation that the update actually applied. Before any worker controls the page, a fallback constant is shown so the badge is never blank. The badge sits just below the map zoom control; tapping or clicking it opens this project's GitHub repository in a new tab (so an installed app stays open).

### Offline support

The app shell (`index.html`, `manifest.json`, vendored Leaflet assets, and Leaflet's license notice) is precached on first load, so the interface, map controls, and required third-party notice remain available offline. Live map tiles and weather/geocoding data still require a connection: those cross-origin requests are not cached and fail gracefully when offline.

---

## Architecture

WX.MAP is a **no-build app with no package-manager dependencies**. All custom UI and logic live in `index.html`; pinned Leaflet assets are stored alongside it so application startup does not depend on a CDN.

```
weather-stations/
├── index.html                      (the whole app)
│   ├── <head>
│   │   ├── manifest link (added by script, skipped on file://) → manifest.json
│   │   ├── inline SVG favicon + apple-touch-icon
│   │   ├── Google Fonts                (Space Mono, Syne — CDN)
│   │   └── Leaflet CSS                 (vendored)
│   ├── <body>
│   │   ├── Header                  (logo, search bar with drag-pin / touch tap-pin, status badge)
│   │   ├── #pin-ghost              (follows cursor during drag)
│   │   ├── <main>
│   │   │   ├── #tap-place-banner   (shown while tap/click-to-place is armed)
│   │   │   ├── #alert-banner       (active NWS watches/warnings — before the map in tab order)
│   │   │   ├── #map                (Leaflet map container — also holds alert area polygons)
│   │   │   ├── #map-overlay        (loading spinner)
│   │   │   ├── #popup-panel        (station info / mobile bottom sheet)
│   │   │   └── #fab-locate         (GPS floating action button)
│   │   ├── #app-version           (bottom-left version badge, links to GitHub)
│   │   ├── #toast                 (error / info notifications)
│   │   └── #update-banner          (slides down when a new version is ready)
│   └── <script>
│       ├── Leaflet JS              (vendored)
│       ├── SW registration + update flow + version badge
│       └── Application script      (vanilla JS)
│           ├── Map initialisation
│           ├── Application state
│           ├── UI helpers
│           ├── Refresh-interval editor
│           ├── Input-type detection
│           ├── Geocoding (ZIP via Nominatim / address via Photon)
│           ├── Legacy API-key cleanup
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
│           ├── Draggable pin + tap/click-to-place
│           ├── Locate Me (Geolocation API)
│           ├── URL auto-trigger
│           └── Mobile enhancements (bottom-sheet height + swipe-to-dismiss)
├── sw.js                           (service worker — caching + updates)
├── manifest.json                   (Web App Manifest — install metadata)
├── leaflet.js / leaflet.css        (pinned Leaflet 1.9.4 code and styles)
├── leaflet.js.map                  (Leaflet debugging source map)
├── images/                         (Leaflet layer/default-marker images)
├── tests/quality.test.mjs          (dependency-free regression checks)
└── LEAFLET-LICENSE.txt             (Leaflet license)
```

---

## Data Sources & APIs

| Service | Purpose | Key required |
|---|---|---|
| [NOAA Weather.gov](https://api.weather.gov/) | Station list, live observations, 7-day and hourly forecasts (and the current hour's chance of rain), active alerts, alert-area zone geometry | No |
| [NOAA watch/warning/advisory map service](https://mapservices.weather.noaa.gov/eventdriven/rest/services/WWA/watch_warn_adv/MapServer) | Live alerts: every alert area inside the map view, one request per view | No |
| [Nominatim (OpenStreetMap)](https://nominatim.openstreetmap.org/) | ZIP → coordinates | No |
| [Photon (komoot)](https://photon.komoot.io/) | Street address → coordinates (+ ZIP fallback) | No |
| [OpenStreetMap Tile Servers](https://tile.openstreetmap.org/) | Map tiles | No |
| [Browser Geolocation API](https://developer.mozilla.org/en-US/docs/Web/API/Geolocation_API) | Device GPS | User permission |

> **Resilience:** every network request (geocoding and weather) is capped by a **15-second timeout** (8 seconds for the Nominatim ZIP lookup, so its Photon fallback still answers promptly; 4 seconds for the optional exact-location lookup of a `?station=` link) — a slow or unreachable API aborts cleanly with an error toast instead of leaving the app stuck "loading". Rapid repeat searches are generation-guarded, so a slow earlier request can never overwrite the results of a newer one.

---

## Offline Support

| Scenario | Behaviour |
|---|---|
| First visit (online) | App shell precached by the service worker |
| Repeat visit (online) | Installed app shell loads consistently from cache; weather data is fetched live |
| New version deployed | Complete replacement shell installs in the background; update banner is shown and applies only on **REFRESH NOW** |
| Visit while offline | Shell served from cache; weather fetches fail gracefully with error toasts |
| `?station=` param offline | Station data fetch fails; error toast shown |

---

## Quality Checks

The repository includes dependency-free regression tests using Node's built-in test runner:

```bash
node --test
```

These checks cover inline-script syntax, HTML identifier/ARIA integrity, manifest and version consistency, atomic service-worker installation/routing/cache isolation, vendored Leaflet assets, alert-popup overlap/dismissal/readability contracts, warning-polygon holes, URL encoding, key-less US-only address lookup, alert-text unwrapping, and stale-response guards.

---

## Browser Compatibility

| Feature | Chrome | Firefox | Edge | Safari |
|---|---|---|---|---|
| Map + search | ✅ | ✅ | ✅ | ✅ (Safari 14.1+ / iOS 14.5+) |
| Draggable pin | ✅ | ✅† | ✅ | ✅ |
| Locate Me (GPS) | ✅* | ✅* | ✅* | ✅* |
| Service Worker (PWA) | ✅ | ✅ | ✅ | ✅ (iOS 11.3+) |
| Install UI | ✅ | Android / desktop extension | ✅ | ✅ (Add to Home Screen / Add to Dock) |

\* Requires HTTPS or localhost. Denied in `file://` context on most browsers.

† Older Firefox versions may not start a drag from a button. Clicking the 📍 button and then the map (click-to-place) works in every browser.
