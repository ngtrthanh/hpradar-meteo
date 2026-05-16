# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.3.0] — 2026-05-16

### Fixed
- **Time-range filter buttons (1H / 6H / 24H / 7D / 30D / All)** now also
  refresh the bottom-panel charts (Tide, Wind Rose, Forecast) and the
  selected-station detail card. Previously `setRange()` only re-fetched
  the right-side data table, so charts stayed frozen on the previous
  range while the button highlight changed.
- HTML default `on` class moved from `1H` to `24H` to match the JS
  initializer (`timeRange = '24h'`). They were out of sync, so first
  paint showed `1H` highlighted while the actual loaded data was
  `last 24h`.

### Added
- **Active-range indicator** in the export bar: `"349 rows · last 24h"`
  instead of just `"349 rows"`. Removes the ambiguity of which window
  the table is showing.
- **Upstream cache short-circuit (`last_max_ts`).** Each source remembers
  the highest message timestamp it has already processed. If the next
  poll returns no message with a newer timestamp, the parse / dedup /
  DB-insert pipeline is skipped and a single `cached (max_ts=...)`
  log line is emitted.
- **`If-Modified-Since`** header sent on every upstream request, with
  the previous response's `Last-Modified` value. Upstream returns
  `304 Not Modified` → log `not_modified (304)` and skip processing.
  (Current upstreams send `Cache-Control: no-cache` so this path is
  defensive only, but it costs nothing and protects against future
  upstream caching.)

### Changed
- **Default upstream poll intervals doubled** to halve wasted load:
  - m3: 60s → 120s
  - m4: 60s → 120s
  - aisinfra: 90s → 180s
  - `DEFAULT_POLL_INTERVAL`: 120s → 180s
  AIS AtoN stations broadcast every ~3 minutes, so polling every 60s
  was running the full pipeline 3× per genuine update. New defaults
  poll at half the data cadence (Nyquist with safety margin) and stay
  well within the upstream buffer capacity (~10 messages × 5 min).
  All values remain env-overridable via `FETCH_SOURCES`.

### Docs
- `docs/BACKEND.md`, `README.md`, `.env.example`,
  `deploy/cloud-init.sh` updated to reflect the new default intervals.
- `AGENTS.md` gains a "Polling cadence" section: rule of thumb is
  *poll at half the data cadence, not faster*.

## [2.2.1] — 2026-05-16

### Fixed
- **Light-theme contrast pass.** Tertiary text (labels, timestamps,
  sub-text) and accent colors were too pale on white backgrounds, often
  failing WCAG AA. Pass made systematically:
  - `--t3` darkened from `#718096` to `#475569` (~7:1 contrast on white)
  - `--t2` darkened from `#4a5568` to `#334155`
  - `--neon` darkened from `#00b377` to `#047857` (~5.5:1 contrast)
  - `--cyan` darkened from `#0099cc` to `#0369a1`
  - `--border` strengthened from `#e2e8f0` to `#cbd5e0`
  - Added `--shadow-card` for subtle panel/card depth in light mode
- **Per-station color palette is now theme-aware.** The neon palette
  (`#00ffaa`, `#ffcc00`, etc.) was unreadable as text on white. A
  parallel darker palette is used in light mode (teal, blue, magenta,
  burnt orange, amber, indigo, etc.) and swapped automatically on
  theme toggle. Markers and the station list re-render on swap.
- **Map marker borders** are now theme-aware: white outline on light
  maps, dark outline on dark maps. Added a 1px outer halo so dots
  remain visible regardless of basemap colors.
- Right-panel table headers use a stronger background (`--bg4`) and
  darker label color for legibility.
- Search input border, time-range buttons, export buttons, and popup
  styling all rebalanced for both themes.

## [2.2.0] — 2026-05-16

### Removed
- **`seastate` field eliminated end-to-end.** AIS-reported sea-state values were
  almost always the IMO "not available" sentinel (`13`); the field offered no
  signal but kept polluting hydro records.
  - Dropped `hydro_obs.seastate` column from the database
    (`ALTER TABLE hydro_obs DROP COLUMN seastate`)
  - Removed `seastate` from `MeteoHydroPoint` model and `parser._SENTINELS` /
    `_BOUNDS`
  - Removed `seastate` from `db.batch_upsert_flagged()` insert tuples and SQL
  - Removed `seastate` from `/api/hydro`, `/api/stations/{mmsi}` responses
  - Removed `seastate` from `/api/alerts` field validation
  - Removed `seastate` from WebSocket broadcast payload
  - Removed `seastate` quality checks from `quality.check_quality()`
  - Removed "Sea" column from the frontend hydro table and station detail
- Cleaned 2,431 historical records previously polluted with `seastate=13`
  (now NULL).

### Fixed
- **Markers for stations after a corrupted record were silently dropped.**
  `syncMK()` iterated `STN` in MMSI order. When a station with invalid
  coordinates (e.g., MMSI 992501017 with `lat=139.785`) reached MapLibre's
  `setLngLat()`, it threw and the surrounding `forEach` aborted, so every
  station after it (including all three Vietnam AtoN stations) was never
  added to the map. Now `syncMK()`:
  - Validates `lat`/`lon` are finite numbers within `[-90, 90]` /
    `[-180, 180]` before processing
  - Wraps `setLngLat()` and marker creation in `try/catch` so a single
    bad station can never break the loop
- **External pollution of `mhdb.hydro_obs`.** A stale deployment of an older
  hydro-api on a different host (`inst2`, `meteo.hpradar.com`) was writing
  unfiltered `seastate=13` rows into the same shared database. The container
  was stopped, its `docker-compose.yml` renamed to `.disabled` so it cannot
  be restarted by accident.

### Added
- **Light/dark theme toggle.** Light is the default. The button (🌙 / ☀️) sits
  in the top-right of the nav. Choice is persisted in `localStorage` under
  `theme`. CSS exposes both palettes via `:root` and
  `:root[data-theme="dark"]`.
- **Liberty as the default map style.** Active style is persisted in
  `localStorage` under `mapStyle`.
- **Map fly-to on station select.** Clicking a station in the sidebar now
  flies the map to that station at zoom ≥ 8 instead of leaving the map
  stationary.
- Default map center adjusted to `[60, 30]` zoom 2 so both European and
  East-Asian stations are visible on first load.
- `AGENTS.md` — operational guardrails for any agent or developer touching
  this repo (see notes below).

### Changed
- `docker-compose.yml`: project renamed from default to `ops-hydro` and
  container renamed to `ops-hydro-api` to avoid name collision with legacy
  deployments on other hosts.

---

## [2.1.0] and earlier
See `git log` for prior history.
