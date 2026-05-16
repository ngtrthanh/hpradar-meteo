# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
