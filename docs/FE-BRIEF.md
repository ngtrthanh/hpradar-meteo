# TIDE WATCH — Frontend Creative Brief

## What is this?

You're building the frontend for a real-time maritime tide monitoring system. The backend is done — it collects water level and wind data from 30+ coastal weather stations worldwide via AIS radio, runs harmonic tidal predictions, and serves everything through a REST + WebSocket API.

Your job: make the best possible interface for people who need to know what the ocean is doing right now and what it will do next.

## The API is ready

Full backend docs: [docs/BACKEND.md](BACKEND.md)
Frontend requirements (reference, not prescription): [docs/FE.md](FE.md)

**Key endpoints you'll use:**
- `GET /api/stations` — all stations with coords, country, record counts, freshness timestamps
- `GET /api/hydro?mmsi=X&start=Y` — water level time series
- `GET /api/meteo?mmsi=X&start=Y` — wind speed/direction time series
- `GET /api/tidal/predict/{mmsi}` — tide prediction (observed + forecast + model quality)
- `GET /api/station-names` — human-readable station names from AIS
- `WS /api/ws/live` — real-time push of new data points
- `GET /api/virtual-stations` — user-created interpolation points
- `GET /api/alerts` — threshold alerts

The API runs at the same origin. No auth needed. CORS enabled.

## What the data looks like

**30+ stations** across: Vietnam (Hải Phòng), UK (Humber estuary — 17 tide gauges), Finland, Sweden, Ireland, Canada, Spain, Estonia, Singapore.

**Water level:** ranges from 0–7m depending on location. Updates every 3–10 minutes. Tidal patterns are clearly visible — sinusoidal curves with 12h or 24h periods.

**Wind:** speed 0–30 m/s, direction 0–360°. Some stations have wind only, some have water level only, some have both.

**Predictions:** harmonic model with R²>0.9 for 22 of 28 stations. Provides 72h hindcast + 48h forecast. Includes bias correction and self-improving refit.

**Virtual stations:** user-created points that interpolate predictions from nearby real stations. Can collect manual measurements and eventually "graduate" to their own prediction model.

## What matters to users

1. **"What's the tide doing NOW?"** — current water level, rising or falling, at a glance
2. **"What will it be at 14:00?"** — prediction chart with high/low water times
3. **"Is this station alive?"** — freshness indicator (last data: 2min ago vs 3 hours ago)
4. **"Show me the pattern"** — tide chart that reveals the rhythm (today vs yesterday)
5. **"Alert me if water drops below 2m"** — threshold alerting
6. **"I measured 1.85m at my dock"** — manual observation entry for virtual stations

## Constraints

- Must work on desktop (primary) and mobile (secondary)
- Must use MapLibre GL JS v5.24+ for the map (globe projection support required)
- Must connect to WebSocket for real-time updates
- Must handle 30+ stations without clutter
- Dark theme preferred (maritime/bridge use at night) but your call on execution
- The backend serves static files from `/static/` — put your build output there, or propose a different serving strategy

## What we DON'T want

- A generic dashboard that could be for anything. This is maritime. It should feel like a professional tool for people who work with tides.
- Tiny text crammed into panels. The primary data (current water level, prediction) should be readable from 2 meters away on a bridge monitor.
- Loading spinners everywhere. Use optimistic UI, skeleton states, or progressive loading.
- A tutorial. The interface should be self-evident to someone who understands tides.

## What we DO want

- **Surprise us.** The current UI is functional but conventional (left panel, map, right panel, bottom charts). If you have a radically different layout idea that serves the data better, go for it.
- **The map is the hero.** Everything else serves the map or is accessed through it.
- **Data density without clutter.** Maritime professionals want to see a lot of information at once — but organized, not dumped.
- **The prediction is the product.** The tide forecast is the most valuable feature. Make it prominent, trustworthy, and beautiful.
- **Real-time should feel alive.** When new data arrives via WebSocket, the UI should breathe — not just silently update a number.

## Starting points (not requirements)

These are ideas, not mandates. Use them, remix them, or ignore them entirely:

- Station markers that encode data visually (size = tidal range? color = current level? ring = freshness?)
- A "focus mode" that takes over the screen for one station's prediction
- Tide clock / gauge visualization instead of (or alongside) line charts
- Wind rose integrated into the map marker itself
- Timeline scrubber that lets you "play" the tide across all stations simultaneously
- Split-screen compare mode for two stations
- Ambient background that shifts with tide state (subtle, not distracting)

## Deliverables

1. `app/static/index.html` — entry point
2. `app/static/` — all CSS, JS, assets
3. Works when served by the existing FastAPI backend (`uvicorn main:app`)
4. README or comments explaining your design decisions

## How to develop

```bash
git clone https://github.com/ngtrthanh/hpradar-meteo.git
cd hpradar-meteo
cp .env.example .env  # edit DB credentials
docker compose up -d
# Backend runs at http://localhost:8113
# Edit files in app/static/ — no build step needed for vanilla JS
# Or set up your own build pipeline and output to app/static/
```

The backend auto-serves `app/static/index.html` at `/` and all files under `/static/*`.

## Questions?

Read [BACKEND.md](BACKEND.md) for every API endpoint. Read [FE.md](FE.md) for the detailed feature spec. Then build something better than what either document describes.
