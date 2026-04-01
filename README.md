# 🌊 TIDE WATCH — AIS Maritime Meteo/Hydro Collector

Real-time maritime meteorological and hydrographic data collection from AIS (Automatic Identification System) broadcasts. Collects water level, wind speed/direction, and sea state data from coastal weather stations worldwide.

![MapLibre](https://img.shields.io/badge/MapLibre_GL-v5.21-00ffaa) ![FastAPI](https://img.shields.io/badge/FastAPI-0.135-009688) ![Python](https://img.shields.io/badge/Python-3.13-3776AB) ![Docker](https://img.shields.io/badge/Docker-Compose-2496ED)

## Live Demo

Accessible via Cloudflare Tunnel at your configured public hostname.

## Features

- **Multi-source AIS polling** — 3 receivers (Vietnam, UK/Europe) with per-source intervals
- **29+ weather stations** across Vietnam, UK, Finland, Sweden, Ireland, Canada
- **Real-time WebSocket push** — live data updates without page refresh
- **MapLibre GL JS SPA** — dark theme, 5 map layers (Dark, Satellite, Topo, Light, Ocean)
- **Per-station charts** — individual tide line charts and wind rose diagrams
- **Time range picker** — 1H/6H/24H/7D/30D/All + custom datetime range
- **Data export** — CSV (Excel-compatible) and JSON download
- **Threshold alerting** — configurable alerts on any metric
- **Data quality filtering** — strips AIS sentinel "not available" values
- **Mobile responsive** — swipeable bottom sheet, overlay panels

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Browser (SPA)                                   │
│  MapLibre GL + Plotly + WebSocket client          │
└──────────┬──────────────────────┬────────────────┘
           │ HTTP /api/*          │ WS /api/ws/live
┌──────────▼──────────────────────▼────────────────┐
│  FastAPI (uvicorn)                                │
│  ├── routes/api.py    REST + WebSocket            │
│  ├── poller.py        per-source async loops      │
│  ├── parser.py        AIS msg type 8 parser       │
│  ├── ws.py            WebSocket broadcast hub     │
│  └── db.py            asyncpg batch inserts       │
└──────────┬───────────────────────────────────────┘
           │
┌──────────▼───────────────────────────────────────┐
│  PostgreSQL / TimescaleDB                         │
│  stations | meteo_obs | hydro_obs | alerts        │
└──────────────────────────────────────────────────┘
           ▲
   AIS Sources (HTTP JSON)
   ├── m3.hpradar.com   (60s)
   ├── m4.hpradar.com   (60s)
   └── aisinfra.hpradar.com (90s)
```

## Quick Start

```bash
# Clone
git clone https://github.com/ngtrthanh/hpradar-meteo.git
cd hpradar-meteo

# Configure
cp .env.example .env
# Edit .env with your DB credentials

# Run
docker compose up -d

# Open http://localhost:8111
```

## Configuration

All config via environment variables (or `.env` file):

| Variable | Default | Description |
|---|---|---|
| `FETCH_SOURCES` | `url\|60,url\|90,...` | Data sources with poll intervals |
| `DB_HOST` | `100.100.40.89` | PostgreSQL host |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_NAME` | `mhdb` | Database name |
| `DB_USER` | `ais_user` | Database user |
| `DB_PASS` | — | Database password |
| `API_KEY` | — | API key (empty = no auth) |
| `RETENTION_DAYS` | `9000` | Data retention period |

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/stations` | List all stations |
| `GET` | `/api/stations/{mmsi}` | Station detail + latest readings |
| `GET` | `/api/meteo?mmsi=&limit=&start=&end=` | Meteorological data |
| `GET` | `/api/hydro?mmsi=&limit=&start=&end=` | Hydrographic data |
| `GET` | `/api/compare?mmsi=X,Y&field=waterlevel` | Multi-station comparison |
| `GET` | `/api/counts` | Record counts |
| `GET` | `/api/health` | System health |
| `GET` | `/api/alerts` | Active alerts + events |
| `POST` | `/api/alerts?field=&operator=&threshold=` | Create alert |
| `WS` | `/api/ws/live` | Real-time data push |

## Cloudflare Tunnel

The app is exposed via Cloudflare Tunnel. See `cloudflared` config below.

```yaml
# ~/.cloudflared/config.yml
tunnel: <your-tunnel-id>
credentials-file: ~/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: meteo.yourdomain.com
    service: http://localhost:8111
    originRequest:
      noTLSVerify: true
  - service: http_status:404
```

```bash
# Install & run
cloudflared tunnel run <tunnel-name>
```

WebSocket works through CF Tunnel automatically — no extra config needed.

## Development

```bash
make dev      # Run locally with hot reload
make build    # Docker build
make up       # Docker compose up
make down     # Docker compose down
make logs     # Tail container logs
make lint     # Syntax check all Python files
```

## Project Structure

```
app/
  config.py          # Environment config, source definitions
  main.py            # FastAPI app, lifespan, middleware
  models.py          # Pydantic models
  parser.py          # AIS message parser + sentinel stripping
  poller.py          # Per-source async poll loops
  db.py              # asyncpg pool, schema, batch inserts
  ws.py              # WebSocket broadcast hub
  quality.py         # Data quality checks
  middleware.py       # Auth + rate limiting
  routes/
    api.py           # REST + WebSocket endpoints
    pages.py         # SPA index route
  static/
    index.html       # SPA shell
    app.css          # Neon dark theme
    app.js           # Map, charts, panels, WebSocket client
Dockerfile
docker-compose.yml
Makefile
```

## License

MIT
