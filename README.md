# 🌊 TIDE WATCH — AIS Maritime Meteo/Hydro Collector

Real-time maritime meteorological and hydrographic data collection from AIS broadcasts. Collects water level, wind speed/direction from coastal weather stations worldwide. Self-improving tidal prediction with harmonic analysis.

![MapLibre](https://img.shields.io/badge/MapLibre_GL-v5.21-00ffaa) ![FastAPI](https://img.shields.io/badge/FastAPI-0.135-009688) ![Python](https://img.shields.io/badge/Python-3.13-3776AB) ![Docker](https://img.shields.io/badge/Docker-Compose-2496ED)

## Live Demo

**[tide.hpradar.com](https://tide.hpradar.com)** — published via Cloudflare Tunnel.

## Features

### Data Collection
- **Multi-source AIS polling** — 3 receivers (Vietnam, UK/Europe) with per-source intervals (60s/90s)
- **30+ weather stations** across Vietnam, UK, Finland, Sweden, Ireland, Canada, Spain, Estonia, Singapore
- **Data quality pipeline** — AIS sentinel stripping, physical bounds checking, spike detection (rate-of-change filter), IRLS outlier rejection
- **Raw data preservation** — bad data flagged, never discarded

### Tidal Prediction
- **Self-improving harmonic analysis** — 36 IHO constituents, Rayleigh criterion for constituent selection
- **Auto-refit** — re-analyzes every 6h, on 10% data growth, or on accuracy degradation
- **Bias correction** — continuous offset from last 6h of observed data compensates seasonal/weather drift
- **22/28 stations R² > 0.9** — excellent fit for stations with meaningful tidal range
- **Virtual stations** — interpolate predictions between nearby stations, add manual measurements, promote to real stations with own harmonic model

### Visualization (SPA)
- **MapLibre GL JS v5.21** — dark neon theme, 5 map layers (Dark, Satellite, Topo, Light, Ocean)
- **Per-station tide charts** — individual line charts per station
- **Wind rose diagrams** — per-station polar wind speed/direction distribution
- **Tide table** — high/low water detection with daily HW/LW times
- **Day overlay** — today vs yesterday vs 2-days-ago comparison
- **Prediction panel** — observed + hindcast + forecast with HW/LW markers, current level, trend arrow
- **Virtual station markers** — yellow squares on map, manual obs entry with predicted value suggestion

### Real-time
- **WebSocket push** — live data updates on each poll cycle
- **Heartbeat indicators** — green (fresh <10min), yellow (stale <1h), red (dead >1h)
- **Station flags** — country flags via lipis/flag-icons, data availability icons (🌊💨)
- **Live station names** — fetched from AIS ships_array, with geocoded fallback

### Operations
- **Time range picker** — 1H/6H/24H/7D/30D/All + custom datetime range
- **Data export** — CSV (Excel BOM) and JSON download
- **Threshold alerting** — configurable alerts on any metric with event history
- **Searchable station list** — by MMSI, name, or country

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Browser (SPA)                                            │
│  MapLibre GL + Plotly + WebSocket client                  │
└──────────┬──────────────────────┬─────────────────────────┘
           │ HTTP /api/*          │ WS /api/ws/live
┌──────────▼──────────────────────▼─────────────────────────┐
│  FastAPI (uvicorn)                                         │
│  ├── routes/api.py    REST + WebSocket + Tidal prediction  │
│  ├── poller.py        per-source async loops + spike filter│
│  ├── parser.py        AIS msg type 8 + sentinel stripping  │
│  ├── tidal.py         harmonic analysis (numpy)            │
│  ├── tidal_cache.py   self-improving prediction cache      │
│  ├── ws.py            WebSocket broadcast hub              │
│  └── db.py            asyncpg batch inserts                │
└──────────┬────────────────────────────────────────────────┘
           │
┌──────────▼────────────────────────────────────────────────┐
│  PostgreSQL / TimescaleDB                                  │
│  stations | meteo_obs | hydro_obs | alerts | alert_events  │
│  virtual_stations | manual_obs                             │
└───────────────────────────────────────────────────────────┘
           ▲
   AIS Sources (HTTP JSON)
   ├── m3.hpradar.com   (60s)
   ├── m4.hpradar.com   (60s)
   └── aisinfra.hpradar.com (90s)
```

## Quick Start

```bash
git clone https://github.com/ngtrthanh/hpradar-meteo.git
cd hpradar-meteo
cp .env.example .env   # edit with your DB credentials
docker compose up -d
# Open http://localhost:8111
```

## Configuration

All config via environment variables (or `.env` file):

| Variable | Default | Description |
|---|---|---|
| `FETCH_SOURCES` | `url\|60,url\|90,...` | Data sources with per-source poll intervals |
| `DB_HOST` | `100.100.40.89` | PostgreSQL host |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_NAME` | `mhdb` | Database name |
| `DB_USER` | `ais_user` | Database user |
| `DB_PASS` | — | Database password |
| `API_KEY` | — | API key (empty = no auth) |
| `RETENTION_DAYS` | `9000` | Data retention period |
| `CF_TUNNEL_TOKEN` | — | Cloudflare Tunnel token |

## API Endpoints

### Data
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/stations` | List all stations with counts, freshness |
| `GET` | `/api/stations/{mmsi}` | Station detail + latest readings |
| `GET` | `/api/meteo?mmsi=&limit=&start=&end=` | Meteorological data |
| `GET` | `/api/hydro?mmsi=&limit=&start=&end=` | Hydrographic data |
| `GET` | `/api/compare?mmsi=X,Y&field=waterlevel` | Multi-station comparison |
| `GET` | `/api/counts` | Record counts |
| `GET` | `/api/health` | System health + source intervals |
| `GET` | `/api/station-names` | Live AIS ship names |

### Tidal Prediction
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/tidal/analyze/{mmsi}` | Full harmonic analysis |
| `GET` | `/api/tidal/predict/{mmsi}?hours_ahead=48&hours_back=72` | Self-improving prediction |
| `GET` | `/api/tidal/virtual/{id}` | Virtual station prediction |

### Virtual Stations
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/virtual-stations` | List virtual stations |
| `POST` | `/api/virtual-stations?name=&lat=&lon=&source_mmsis=` | Create |
| `DELETE` | `/api/virtual-stations/{id}` | Delete |
| `POST` | `/api/virtual-stations/{id}/obs?ts=&waterlevel=` | Add manual measurement |
| `GET` | `/api/virtual-stations/{id}/obs` | List measurements |
| `POST` | `/api/virtual-stations/{id}/promote` | Promote to real station (≥48 obs) |

### Alerts & Real-time
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/alerts` | Active alerts + events |
| `POST` | `/api/alerts?field=&operator=&threshold=` | Create alert |
| `DELETE` | `/api/alerts/{alert_id}` | Deactivate alert |
| `WS` | `/api/ws/live` | Real-time data push |

## Virtual Station Lifecycle

```
CREATE                    COLLECT                   PROMOTE
  📍 Name, coords          ✏️ Manual measurements     🎓 ≥48 obs → own MMSI
  📡 Source MMSIs           📊 Interpolated predict    📈 Own harmonic model
  🗺️ Appears on map        💡 Predicted value hint    🔮 Self-improving
```

## Deployment

See [deploy/DEPLOY.md](deploy/DEPLOY.md) for full deployment guide including:
- Zero-touch VPS setup via cloud-init
- Multi-environment CI/CD (dev → staging → production)
- Cloudflare Tunnel configuration
- Watchtower auto-update

## Project Structure

```
app/
  config.py          # Environment config, source definitions
  main.py            # FastAPI app, lifespan, middleware
  models.py          # Pydantic models
  parser.py          # AIS message parser + sentinel stripping
  poller.py          # Per-source async poll loops + spike filter
  db.py              # asyncpg pool, schema, batch inserts
  ws.py              # WebSocket broadcast hub
  tidal.py           # Harmonic analysis (numpy, IRLS, Rayleigh)
  tidal_cache.py     # Self-improving prediction cache
  quality.py         # Data quality checks
  middleware.py       # Auth + rate limiting
  routes/
    api.py           # REST + WebSocket + Tidal endpoints
    pages.py         # SPA index route
  static/
    index.html       # SPA shell
    app.css          # Neon dark theme
    app.js           # Map, charts, panels, WebSocket client
Dockerfile
docker-compose.yml
Makefile
deploy/
  DEPLOY.md          # Full deployment guide
  docker-compose.prod.yml
  docker-compose.staging.yml
  docker-compose.dev.yml
  cloud-init.sh
```

## License

MIT
