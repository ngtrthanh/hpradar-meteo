# TIDE WATCH — Backend API Documentation

## Base URL
```
https://tide.hpradar.com/api
```

## Authentication
Optional API key via `Authorization: Bearer <key>` header or `?api_key=<key>` query param. Empty `API_KEY` env var disables auth.

Rate limit: 60 req/min per IP. Debug endpoints: 1 req/min.

---

## Endpoints

### Stations

#### `GET /api/stations`
List all stations with metadata, record counts, and freshness.

**Response:**
```json
[
  {
    "mmsi": 995741977,
    "dac": 1,
    "fi": 31,
    "lon": 106.907715,
    "lat": 20.822084,
    "country": "Vietnam",
    "name": null,
    "meteo_count": 5200,
    "hydro_count": 4800,
    "has_meteo": true,
    "has_hydro": true,
    "last_meteo_ts": "2026-04-25T06:00:00+00:00",
    "last_hydro_ts": "2026-04-25T06:00:00+00:00"
  }
]
```

#### `GET /api/stations/{mmsi}`
Station detail with latest readings.

**Response:**
```json
{
  "station": { "mmsi": 995741977, "lat": 20.822, "lon": 106.907, "country": "Vietnam" },
  "latest_meteo": { "ts": "...", "wspeed": 5.0, "wdir": 143 },
  "latest_hydro": { "ts": "...", "waterlevel": 2.45, "seastate": null },
  "meteo_count": 5200,
  "hydro_count": 4800
}
```

#### `GET /api/station-names`
Live station names from AIS ships_array. Cached 180s.

**Response:**
```json
{
  "995741977": "LACH HUYEN METEO",
  "992351272": "GRIMSBY [V]",
  "995741986": "ARRYO"
}
```

---

### Observations

#### `GET /api/meteo`
Meteorological data (wind speed, direction).

| Param | Type | Default | Description |
|---|---|---|---|
| `mmsi` | int | — | Filter by station |
| `limit` | int | 500 | Max rows (cap 5000) |
| `start` | ISO8601 | — | Start time filter |
| `end` | ISO8601 | — | End time filter |

**Response:**
```json
[
  { "mmsi": 995741977, "ts": "2026-04-25T06:00:00+00:00", "wspeed": 5.0, "wdir": 143 }
]
```

#### `GET /api/hydro`
Hydrographic data (water level).

| Param | Type | Default | Description |
|---|---|---|---|
| `mmsi` | int | — | Filter by station |
| `limit` | int | 500 | Max rows (cap 5000) |
| `start` | ISO8601 | — | Start time filter |
| `end` | ISO8601 | — | End time filter |

**Response:**
```json
[
  { "mmsi": 995741977, "ts": "2026-04-25T06:00:00+00:00", "waterlevel": 2.45, "seastate": null }
]
```

#### `GET /api/compare`
Multi-station comparison.

| Param | Type | Description |
|---|---|---|
| `mmsi` | string | Comma-separated MMSIs (max 20) |
| `field` | string | `waterlevel`, `wspeed`, `wdir` |
| `limit` | int | Per-station limit |
| `start` | ISO8601 | Start time |
| `end` | ISO8601 | End time |

**Response:**
```json
{
  "995741977": [{ "ts": "...", "value": 2.45 }],
  "995741986": [{ "ts": "...", "value": 2.10 }]
}
```

#### `GET /api/counts`
Global record counts. Cached 30s, invalidated on new data.

**Response:**
```json
{ "stations": 32, "meteo_observations": 76000, "hydro_observations": 75000 }
```

---

### Tidal Prediction

#### `GET /api/tidal/analyze/{mmsi}`
Full harmonic analysis for a station.

**Response:**
```json
{
  "mmsi": 995741977,
  "mean": 2.249,
  "r2": 0.9767,
  "rmse": 0.1358,
  "n_points": 20000,
  "n_constituents": 33,
  "t0": "2025-09-21T17:06:52+00:00",
  "constituents": {
    "O1": { "freq": 13.943, "amp": 0.808, "phase": 290.5, "a": 0.283, "b": -0.757, "f": 1.173, "u": -4.31 },
    "K1": { "freq": 15.041, "amp": 0.688, "phase": 328.2, "a": 0.585, "b": -0.363, "f": 1.105, "u": 3.55 }
  }
}
```

#### `GET /api/tidal/predict/{mmsi}`
Self-improving prediction with hindcast + forecast + bias correction.

| Param | Type | Default | Description |
|---|---|---|---|
| `hours_ahead` | int | 48 | Forecast horizon |
| `hours_back` | int | 72 | Hindcast window |

**Response:**
```json
{
  "mmsi": 995741977,
  "r2": 0.9767,
  "rmse": 0.1358,
  "recent_rmse": 0.018,
  "bias": -0.275,
  "n_constituents": 33,
  "fitted_ago_min": 45,
  "observed_start": "2026-04-22T06:00:00+00:00",
  "observed_end": "2026-04-25T06:00:00+00:00",
  "predict_end": "2026-04-27T06:00:00+00:00",
  "predictions": [
    { "ts": "2026-04-22T06:00:00+00:00", "level": 1.138 }
  ],
  "top_constituents": [
    ["O1", { "freq": 13.943, "amp": 0.808, "phase": 290.5 }]
  ]
}
```

**Self-improving behavior:**
- Auto-refits every 6 hours
- Refits on 10% data growth
- Refits on accuracy degradation (recent RMSE > 2× training RMSE)
- Bias correction from last 6h of observed vs predicted

#### `GET /api/tidal/virtual/{station_id}`
Prediction for a virtual station.

**Response:** Same as predict, plus:
```json
{
  "name": "CFC-TKP",
  "mode": "interpolated",  // or "own_model" if promoted
  "sources": { "995741977": 0.418, "995741986": 0.582 }
}
```

---

### Virtual Stations

#### `GET /api/virtual-stations`
List all virtual stations.

**Response:**
```json
[
  {
    "id": 1,
    "name": "CFC-TKP",
    "lat": 20.961178,
    "lon": 106.75494,
    "source_mmsis": "995741977,995741986",
    "promoted_mmsi": null,
    "created_at": "2026-04-25T06:39:02+00:00",
    "obs_count": 12,
    "promoted": false
  }
]
```

#### `POST /api/virtual-stations`
Create virtual station.

| Param | Type | Description |
|---|---|---|
| `name` | string | Station name |
| `lat` | float | Latitude |
| `lon` | float | Longitude |
| `source_mmsis` | string | Comma-separated source MMSIs |

#### `DELETE /api/virtual-stations/{id}`
Delete virtual station and its observations.

#### `POST /api/virtual-stations/{id}/obs`
Add manual water level measurement.

| Param | Type | Description |
|---|---|---|
| `ts` | ISO8601 | Measurement timestamp |
| `waterlevel` | float | Water level in metres |
| `note` | string | Optional note |

#### `GET /api/virtual-stations/{id}/obs`
List manual observations.

#### `POST /api/virtual-stations/{id}/promote`
Promote to real station. Requires ≥48 observations. Copies data to `hydro_obs`, assigns pseudo-MMSI (900000000+id), enables own harmonic model.

---

### Alerts

#### `GET /api/alerts`
List active alerts and recent events.

**Response:**
```json
{
  "alerts": [
    { "id": 1, "mmsi": 995741977, "field": "waterlevel", "operator": ">", "threshold": 3.5, "active": true }
  ],
  "recent_events": [
    { "alert_id": 1, "mmsi": 995741977, "ts": "...", "value": 3.62, "triggered_at": "..." }
  ]
}
```

#### `POST /api/alerts`
| Param | Type | Description |
|---|---|---|
| `mmsi` | int | Optional — null = all stations |
| `field` | string | `waterlevel`, `wspeed`, `wdir`, `seastate` |
| `operator` | string | `>`, `<`, `>=`, `<=`, `=` |
| `threshold` | float | Trigger value |

#### `DELETE /api/alerts/{alert_id}`
Deactivate alert.

---

### Real-time

#### `WS /api/ws/live`
WebSocket endpoint. Pushes new data on each poll cycle.

**Message format:**
```json
{
  "type": "new_data",
  "count": 17,
  "ts": "2026-04-25T06:01:00Z",
  "points": [
    {
      "mmsi": 995741977,
      "ts": "2026-04-25T06:00:52+00:00",
      "lat": 20.822,
      "lon": 106.907,
      "wspeed": 5.0,
      "wdir": 143,
      "waterlevel": 2.45,
      "seastate": null,
      "country": "Vietnam"
    }
  ]
}
```

Only quality=0 (good) data is broadcast. Max 100 points per message.

#### `GET /api/health`
```json
{
  "status": "ok",
  "sources": [
    { "url": "https://m3.hpradar.com/api/binmsgs.json", "interval": 60.0 }
  ],
  "db_pool": "connected",
  "poller": "running",
  "ws_clients": 2
}
```

#### `GET /api/debug/fetch`
Trigger immediate fetch from all sources.

---

## Data Quality

### Parser (before storage)
| Field | Sentinel (→ null) | Physical bounds |
|---|---|---|
| seastate | ≥ 13 | 0–9 |
| wspeed | ≥ 127 | 0–100 m/s |
| wdir | ≥ 360 | 0–359° |
| waterlevel | ≥ 327 or ≤ -327 | -15 to 25 m |

### Spike filter (per poll cycle)
- Tracks last known waterlevel per MMSI
- Flags readings where Δ > 1.0m AND rate > 6.0 m/hr
- Flagged data stored with quality=2, not discarded

### Insert rules
- Hydro row requires non-null waterlevel
- Meteo row requires non-null wspeed or wdir
- Alerts only fire on quality=0 data
- WebSocket only broadcasts quality=0 data

---

## Database Schema

```sql
stations (mmsi PK, dac, fi, lon, lat, country)
meteo_obs (mmsi FK, ts, wspeed, wdir) PK(mmsi,ts)
hydro_obs (mmsi FK, ts, waterlevel, seastate) PK(mmsi,ts)
alerts (id PK, mmsi, field, operator, threshold, active, created_at)
alert_events (id PK, alert_id FK, mmsi, ts, value, triggered_at)
virtual_stations (id PK, name, lat, lon, source_mmsis, promoted_mmsi, created_at)
manual_obs (id PK, station_id, ts, waterlevel, note, created_at)
```

Indexes: `idx_meteo_ts (ts DESC)`, `idx_hydro_ts (ts DESC)`

---

## Polling Architecture

3 independent async loops, each with own interval:
```
m3.hpradar.com      → 60s
m4.hpradar.com      → 60s
aisinfra.hpradar.com → 90s
```

Each cycle: fetch → parse → sentinel strip → dedup → spike flag → batch insert → alert check → WebSocket broadcast.
