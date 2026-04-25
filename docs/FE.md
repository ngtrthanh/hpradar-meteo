# TIDE WATCH — Frontend Product Requirements Document

## Product Overview
TIDE WATCH is a real-time maritime meteorological and hydrographic monitoring application. The frontend is a single-page application (SPA) that displays live AIS weather station data on an interactive map with charts, predictions, and alerting.

**Live instance:** tide.hpradar.com
**Backend API docs:** [BACKEND.md](BACKEND.md)

---

## Target Users
1. **Port operators** — need current water levels and short-term predictions for vessel scheduling
2. **Mariners** — need tide forecasts and wind conditions for navigation planning
3. **Data analysts** — need historical data export and multi-station comparison
4. **Station managers** — need to create virtual stations, enter manual measurements, manage alerts

---

## Technical Requirements

### Stack
- **Map:** MapLibre GL JS v5.24+ (vector tiles, globe projection)
- **Charts:** Plotly.js (or equivalent — Plotly is current, can be replaced)
- **Real-time:** WebSocket client connecting to `/api/ws/live`
- **No framework required** — vanilla JS is fine, or React/Vue/Svelte at developer's discretion
- **Responsive:** desktop (3-panel layout) + mobile (bottom sheet)

### API
- All data from REST endpoints at `/api/*` (see BACKEND.md)
- WebSocket at `/api/ws/live` for real-time push
- CORS enabled, no auth required for read endpoints

---

## Page Structure

### Layout (Desktop)
```
┌─────────────────────────────────────────────────────────┐
│  TOP NAV BAR (fixed, 48px)                               │
│  Logo | Panel toggles | Selected station | Stats         │
├────────┬────────────────────────────────────┬────────────┤
│ LEFT   │         MAP (MapLibre GL)          │  RIGHT     │
│ 280px  │                                    │  320px     │
│        │  Globe/flat toggle (top-right)     │            │
│Station │  Style selector (top-left)         │ Meteo tab  │
│list    │  Scale bar (bottom-left)           │ Hydro tab  │
│search  │  Fullscreen (bottom-right)         │            │
│detail  │                                    │ Time range │
│        │                                    │ Data table │
│        │                                    │ Export     │
├────────┴────────────────────────────────────┴────────────┤
│  BOTTOM PANEL (collapsible, 320px)                       │
│  Tabs: Charts | Forecast | System                        │
│  Sub-tabs per main tab                                   │
└─────────────────────────────────────────────────────────┘
```

### Layout (Mobile ≤1100px)
```
┌──────────────────┐
│ NAV (compact)    │
├──────────────────┤
│                  │
│   MAP (full)     │
│                  │
├──────────────────┤
│ Bottom sheet     │
│ 3 snap points:   │
│  peek (60px)     │
│  half (40vh)     │
│  full (85vh)     │
└──────────────────┘
Left/Right panels: slide-in overlays with backdrop
```

---

## Features

### F1: Station Map
- **Map styles:** Dropdown selector with 8+ styles (vector: OpenFreeMap Dark/Positron/Liberty/Bright; raster: ESRI Satellite/Ocean, CartoDB Dark, OpenTopo)
- **Globe projection:** MapLibre GlobeControl (top-right), default to globe, set via `map.on('style.load', () => map.setProjection({type:'globe'}))`
- **Controls:** NavigationControl (bottom-right), ScaleControl (bottom-left), FullscreenControl (bottom-right)
- **Station markers:** Colored circles (12px), one color per station from palette. Marker cache using `Map()` for efficient reuse
- **Virtual station markers:** Yellow squares (14px), distinct from real stations
- **Marker states:**
  - Fresh (<10min): bright, 2s pulse animation
  - Stale (<1h): dimmer, 4s slow pulse
  - Dead (>1h): 30% opacity, no animation
- **Hover:** Popup with station name, flag, coords, data types (🌊💨), record count
- **Click:** Select station → updates all panels, ccbar appears, marker enlarges
- **Click empty map:** Deselect station
- **No auto-pan** — user controls map freely at all times

**Data source:** `GET /api/stations` (includes `last_meteo_ts`, `last_hydro_ts` for freshness)

### F2: Station List (Left Panel)
- **Search:** Filter by MMSI, station name, or country
- **Each item shows:**
  - Freshness dot (animated per F1 states)
  - Country flag (lipis/flag-icons CSS, ISO 2-letter code)
  - Station name (from `/api/station-names`, fallback to static geocoded names)
  - Data type icons: 🌊 (hydro), 💨 (meteo)
  - Record count
- **Dead stations:** Faded to 40% opacity, brighten on hover
- **Click:** Same as clicking marker on map
- **Sort:** By freshness (most active first)

**Station name sources:**
1. Live AIS names from `GET /api/station-names` (fetched once on load)
2. Static fallback map (geocoded location names)

**Country → ISO code mapping needed for flags:**
```
Vietnam→vn, United Kingdom→gb, Finland→fi, Sweden→se,
Ireland→ie, Canada→ca, Spain→es, Estonia→ee, Singapore→sg, ...
```

### F3: Current Conditions Bar
- Appears when a station is selected (between nav and map)
- Shows: flag + station name, water level (large, cyan), trend arrow (▲ rising / ▼ falling), wind speed (neon), wind direction, last updated time
- Close button (×) deselects station
- **Also:** Nav bar shows selected station name + × for deselect when left panel is hidden

**Data source:** `GET /api/meteo?mmsi=X&limit=2` + `GET /api/hydro?mmsi=X&limit=2` (2 points for trend calculation)

### F4: Data Tables (Right Panel)
- **2 tabs:** 💨 Meteo, 🌊 Hydro
- **Time range picker:** 1H / 6H / 24H / 7D / 30D / All buttons
- **Table columns:**
  - Meteo: MMSI, Wind (m/s), Dir (°), When (relative time)
  - Hydro: MMSI, Level (m), Sea state, When
- **Export:** CSV (UTF-8 BOM for Excel) and JSON download buttons
- **Row count** displayed next to export buttons
- Filters by selected station if one is selected, otherwise shows all

**Data source:** `GET /api/meteo?limit=500&mmsi=X&start=Y` / `GET /api/hydro?...`

### F5: Bottom Panel — Charts Tab
**Sub-tabs:** Tide | Wind Rose

#### F5a: Tide Charts
- One chart per station (grid, max 9, 3 columns)
- Line chart: waterlevel over time, colored per station
- Fill to zero with transparent gradient
- Current-time vertical line (yellow dotted)
- Respects time range picker

**Data source:** `GET /api/hydro?mmsi=X&limit=1000&start=Y`

#### F5b: Wind Rose
- One polar chart per station (grid, max 9)
- 16 direction sectors (N, NNE, NE, ...)
- 5 speed bins: 0-2, 2-5, 5-10, 10-20, 20+ m/s
- Stacked bar polar, clockwise, north at top
- Percentage on radial axis

**Data source:** `GET /api/meteo?mmsi=X&limit=2000`

### F6: Bottom Panel — Forecast Tab
**Sub-tabs:** Predict | Tide Table | Day Overlay

#### F6a: Prediction Panel
- Chart showing: observed (green solid), model hindcast (cyan dotted), forecast (magenta solid/dashed)
- HW/LW markers: ▲ yellow triangles at highs, ▼ cyan triangles at lows, with level labels
- Yellow "Now" vertical line at observed/forecast boundary
- Shaded forecast zone
- **Side info panel:**
  - Current level (large), trend arrow
  - Next HW/LW time and level
  - R² (color-coded: green >0.8, yellow >0.5, red <0.5)
  - Recent RMSE, bias correction amount
  - Model age ("fitted X min ago")
  - Top 10 constituents table (name, amplitude in cm, phase)
  - Warning for low R²: "⚠ Low model fit — prediction unreliable"
- **Low confidence:** Forecast line becomes dashed and faded when R² < 0.7
- **Virtual stations button:** Overlays all virtual station predictions (yellow dash-dot)

**Data source:** `GET /api/tidal/predict/{mmsi}?hours_ahead=48&hours_back=72`

#### F6b: Tide Table
- Table: Station | Date | HW Level | HW Time | LW Level | LW Time
- Peak/trough detection from waterlevel series
- 7-day view per station
- Max 6 stations

**Data source:** `GET /api/hydro?mmsi=X&limit=2000`

#### F6c: Day Overlay
- One chart per station (grid, max 3)
- 3 traces: Today (bright), Yesterday (medium), 2 days ago (faint)
- X-axis: 0-24 hours
- Allows visual comparison of tidal pattern day-over-day

**Data source:** `GET /api/hydro?mmsi=X&limit=5000`

### F7: Bottom Panel — System Tab
**Sub-tabs:** Status | Alerts | Virtual

#### F7a: System Status
- Cards: Database (connected/disconnected), Poller (running/stopped), WS clients count
- Data sources list with per-source poll interval

**Data source:** `GET /api/health`

#### F7b: Alerts
- **Create form:** field dropdown (waterlevel/wspeed), operator (>/</>=/<=/=), threshold input, create button
- **Active alerts list** with delete button per alert
- **Recent events** list (last 20)

**Data source:** `GET /api/alerts`, `POST /api/alerts`, `DELETE /api/alerts/{id}`

#### F7c: Virtual Stations
- **Create form:** name, lat, lon, source MMSIs
- **Per station card:**
  - Name, coords, source MMSIs
  - Observation count + "need N more obs" progress
  - Manual obs entry: timestamp (default=now), waterlevel (default=current predicted value from `GET /api/tidal/virtual/{id}?hours_ahead=1&hours_back=0`)
  - Promote button (appears at ≥48 obs) with confirmation dialog
  - Delete button (requires typing station name to confirm)

**Data source:** `GET/POST/DELETE /api/virtual-stations`, `POST /api/virtual-stations/{id}/obs`, `GET /api/tidal/virtual/{id}`

### F8: Real-time Updates
- **WebSocket:** Connect to `ws://host/api/ws/live` on page load
- **Auto-reconnect:** Exponential backoff (1s → 30s max)
- **On new_data message:**
  - Refresh nav bar counts
  - Refresh right panel data table
  - Update current conditions bar if selected station has new data
  - Flash health dot green briefly
  - Flash updated stations in station list (green background, 1.5s fade)
- **Fallback:** HTTP poll every 60s if WebSocket disconnects

### F9: Mobile UX
- Left/right panels: slide-in overlays with dark backdrop, tap backdrop to close
- Bottom sheet: swipe handle, 3 snap points (peek 60px, half 40vh, full 85vh)
- Nav bar: hide stats on small screens (≤640px), keep panel toggle buttons
- Charts: single column grid on mobile
- Chart boxes: 220px height on mobile (vs 280px desktop)

---

## Visual Design

### Theme: Dark Neon Maritime
Scientific/maritime aesthetic — precision over decoration.

### Color Palette
| Role | Hex | Usage |
|---|---|---|
| Primary / Live | `#00ffaa` | Active data, healthy, primary actions |
| Hydro / Cyan | `#00d4ff` | Water level values, low water markers |
| Forecast / Magenta | `#ff00aa` | Prediction curves, forecast zone |
| Virtual / Yellow | `#ffcc00` | Virtual stations, warnings, HW markers |
| Alert / Red | `#ff3355` | Errors, dead stations, destructive actions |
| Stale / Amber | `#ff8800` | Stale data, degraded state |
| Background 1 | `#080c14` | Body |
| Background 2 | `#0d1320` | Panels |
| Background 3 | `#131b2e` | Cards, inputs, chart bg |
| Text primary | `#f0f4ff` | Headings, values |
| Text secondary | `#a0b4d0` | Descriptions |
| Text muted | `#607090` | Labels, timestamps |
| Border | `#1a2540` | Dividers, grid lines |

### Typography
- Font: Inter (Google Fonts)
- Display: 1.8rem / 800 weight (current conditions values)
- Heading: 0.85rem / 700
- Body: 0.78rem / 400
- Label: 0.68rem / 700 uppercase
- Caption: 0.62rem / 400

### Iconography
- Data types: 🌊 hydro, 💨 meteo, ⚡ alerts, 📍 virtual, 🔮 prediction
- Status: CSS animated dots (not emoji)
- Flags: lipis/flag-icons v7.2.3 via CDN (`<span class="fi fi-vn">`)
- No decorative icons — every icon conveys data meaning

---

## External Dependencies
- MapLibre GL JS v5.24.0: `https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js`
- Plotly.js: `https://cdn.plot.ly/plotly-2.27.0.min.js`
- Flag Icons: `https://cdn.jsdelivr.net/gh/lipis/flag-icons@7.2.3/css/flag-icons.min.css`
- Inter font: `https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800`

---

## Acceptance Criteria
1. All 30+ stations visible on map with correct markers and freshness states
2. Station selection updates all panels consistently
3. Tide prediction chart shows observed + hindcast + forecast with HW/LW markers
4. Wind rose renders correctly with 16 sectors and 5 speed bins
5. WebSocket connects and updates UI in real-time without page refresh
6. Virtual station can be created, manual obs entered, and promoted
7. CSV/JSON export produces valid files with correct data
8. Mobile: bottom sheet swipes between 3 snap points, panels slide in/out
9. Globe projection works with GlobeControl toggle
10. Style switching preserves markers and projection
