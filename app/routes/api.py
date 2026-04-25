import time
import logging
from typing import Optional
from datetime import datetime, timedelta

from fastapi import APIRouter, HTTPException, Query, Request, WebSocket, WebSocketDisconnect

import config
import db
import poller
import ws as wshub

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api")

# Simple in-memory cache (Phase 2 item 8)
_cache: dict[str, tuple[float, object]] = {}
CACHE_TTL = 30  # seconds


def _cached(key: str):
    entry = _cache.get(key)
    if entry and (time.time() - entry[0]) < CACHE_TTL:
        return entry[1]
    return None


def _set_cache(key: str, val):
    _cache[key] = (time.time(), val)


def _clamp_limit(limit: int) -> int:
    return max(1, min(limit, config.MAX_QUERY_LIMIT))


def _validate_mmsi(mmsi: Optional[int]):
    if mmsi is not None and (mmsi < 1000 or mmsi > 999999999):
        raise HTTPException(400, "Invalid MMSI")


@router.get("/counts")
async def get_counts():
    """Record counts — cached 30s."""
    cached = _cached("counts")
    if cached:
        return cached
    pool = await db.get_pool()
    async with pool.acquire() as conn:
        s = await conn.fetchval("SELECT COUNT(*) FROM stations")
        m = await conn.fetchval("SELECT COUNT(*) FROM meteo_obs")
        h = await conn.fetchval("SELECT COUNT(*) FROM hydro_obs")
    result = {"stations": s or 0, "meteo_observations": m or 0, "hydro_observations": h or 0}
    _set_cache("counts", result)
    return result


@router.get("/stations")
async def get_stations(limit: int = Query(1000)):
    cached = _cached("stations")
    if cached:
        return cached
    pool = await db.get_pool()
    async with pool.acquire() as conn:
        has_name = await conn.fetchval(
            "SELECT COUNT(*) > 0 FROM information_schema.columns "
            "WHERE table_name='stations' AND column_name='name'")
        name_col = "s.name," if has_name else "NULL AS name,"
        rows = await conn.fetch(f"""
            SELECT s.mmsi, s.dac, s.fi, s.lon, s.lat, s.country, {name_col}
                   (SELECT COUNT(*) FROM meteo_obs m WHERE m.mmsi = s.mmsi) AS meteo_count,
                   (SELECT COUNT(*) FROM hydro_obs h WHERE h.mmsi = s.mmsi) AS hydro_count,
                   (SELECT MAX(ts) FROM meteo_obs m WHERE m.mmsi = s.mmsi) AS last_meteo_ts,
                   (SELECT MAX(ts) FROM hydro_obs h WHERE h.mmsi = s.mmsi) AS last_hydro_ts
            FROM stations s ORDER BY s.mmsi LIMIT $1
        """, _clamp_limit(limit))
        result = []
        for r in rows:
            d = dict(r)
            d["has_meteo"] = r["meteo_count"] > 0
            d["has_hydro"] = r["hydro_count"] > 0
            for k in ("last_meteo_ts", "last_hydro_ts"):
                if d[k]:
                    d[k] = d[k].isoformat()
            result.append(d)
        _set_cache("stations", result)
        return result


@router.get("/stations/{mmsi}")
async def get_station_detail(mmsi: int):
    """Station detail with latest readings and quality summary (Phase 6 item 29)."""
    _validate_mmsi(mmsi)
    pool = await db.get_pool()
    async with pool.acquire() as conn:
        station = await conn.fetchrow("SELECT * FROM stations WHERE mmsi = $1", mmsi)
        if not station:
            raise HTTPException(404, "Station not found")

        latest_meteo = await conn.fetchrow(
            "SELECT ts, wspeed, wdir FROM meteo_obs WHERE mmsi=$1 ORDER BY ts DESC LIMIT 1", mmsi)
        latest_hydro = await conn.fetchrow(
            "SELECT ts, waterlevel, seastate FROM hydro_obs WHERE mmsi=$1 ORDER BY ts DESC LIMIT 1", mmsi)
        meteo_count = await conn.fetchval("SELECT COUNT(*) FROM meteo_obs WHERE mmsi=$1", mmsi)
        hydro_count = await conn.fetchval("SELECT COUNT(*) FROM hydro_obs WHERE mmsi=$1", mmsi)

    def row_to_dict(r):
        if not r: return None
        d = dict(r)
        for k, v in d.items():
            if hasattr(v, 'isoformat'): d[k] = v.isoformat()
        return d

    return {
        "station": dict(station),
        "latest_meteo": row_to_dict(latest_meteo),
        "latest_hydro": row_to_dict(latest_hydro),
        "meteo_count": meteo_count,
        "hydro_count": hydro_count,
    }


@router.get("/meteo")
async def get_meteo(
    mmsi: Optional[int] = Query(None),
    limit: int = Query(500),
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
):
    """Meteo data with optional time-range filter (Phase 2 item 6)."""
    _validate_mmsi(mmsi)
    pool = await db.get_pool()
    lim = _clamp_limit(limit)
    clauses, params = _build_filters(mmsi, start, end)
    q = f"SELECT mmsi, ts, wspeed, wdir FROM meteo_obs {clauses} ORDER BY ts DESC LIMIT {lim}"

    async with pool.acquire() as conn:
        rows = await conn.fetch(q, *params)
    return [{"mmsi": r["mmsi"], "ts": r["ts"].isoformat(), "wspeed": r["wspeed"], "wdir": r["wdir"]}
            for r in rows]


@router.get("/hydro")
async def get_hydro(
    mmsi: Optional[int] = Query(None),
    limit: int = Query(500),
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    raw: bool = Query(False, description="Include flagged/spike data"),
):
    _validate_mmsi(mmsi)
    pool = await db.get_pool()
    lim = _clamp_limit(limit)
    clauses, params = _build_filters(mmsi, start, end)
    q = f"SELECT mmsi, ts, waterlevel, seastate FROM hydro_obs {clauses} ORDER BY ts DESC LIMIT {lim}"

    async with pool.acquire() as conn:
        rows = await conn.fetch(q, *params)
    return [{"mmsi": r["mmsi"], "ts": r["ts"].isoformat(),
             "waterlevel": r["waterlevel"], "seastate": r["seastate"]}
            for r in rows]


@router.get("/compare")
async def compare(
    mmsi: str = Query(..., description="Comma-separated MMSIs"),
    field: str = Query("waterlevel"),
    limit: int = Query(1000),
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
):
    """Multi-station comparison (Phase 6 item 26)."""
    mmsi_list = [int(m.strip()) for m in mmsi.split(",") if m.strip()]
    if not mmsi_list or len(mmsi_list) > 20:
        raise HTTPException(400, "Provide 1-20 MMSIs")

    table = "meteo_obs" if field in ("wspeed", "wdir") else "hydro_obs"
    lim = _clamp_limit(limit)
    pool = await db.get_pool()

    result = {}
    async with pool.acquire() as conn:
        for m in mmsi_list:
            clauses, params = _build_filters(m, start, end)
            q = f"SELECT ts, {field} FROM {table} {clauses} ORDER BY ts DESC LIMIT {lim}"
            rows = await conn.fetch(q, *params)
            result[str(m)] = [{"ts": r["ts"].isoformat(), "value": r[field]} for r in rows]
    return result


@router.get("/health")
async def health():
    pool = await db.get_pool() if db._pool else None
    return {
        "status": "ok",
        "sources": [{"url": s["url"], "interval": s["interval"]} for s in config.SOURCES],
        "db_pool": "connected" if pool else "disconnected",
        "poller": "running" if poller.is_running() else "stopped",
        "ws_clients": len(wshub._clients),
    }


@router.websocket("/ws/live")
async def websocket_live(websocket: WebSocket):
    """Real-time data push. Clients receive new_data messages on each poll cycle."""
    await wshub.connect(websocket)
    try:
        while True:
            # Keep connection alive; client can send pings
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await wshub.disconnect(websocket)


@router.get("/debug/fetch")
async def debug_fetch():
    await poller.fetch_once()
    return {"status": "fetch completed"}


@router.get("/tidal/analyze/{mmsi}")
async def tidal_analyze(mmsi: int, limit: int = Query(5000)):
    """Run harmonic analysis on a station's waterlevel data."""
    _validate_mmsi(mmsi)
    pool = await db.get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT ts, waterlevel FROM hydro_obs WHERE mmsi=$1 AND waterlevel IS NOT NULL "
            "ORDER BY ts ASC", mmsi)
    if len(rows) < 48:
        raise HTTPException(400, f"Need ≥48 points, got {len(rows)}")
    if len(rows) > 20000:
        step = max(1, len(rows) // 20000)
        rows = rows[::step]
    if len(rows) < 48:
        raise HTTPException(400, f"Need ≥48 points, got {len(rows)}")

    from tidal import analyze
    times = [r["ts"] for r in rows]
    values = [float(r["waterlevel"]) for r in rows]
    result = analyze(times, values)
    result["mmsi"] = mmsi
    return result


@router.get("/tidal/predict/{mmsi}")
async def tidal_predict(
    mmsi: int,
    hours_ahead: int = Query(48, description="Hours to predict into future"),
    hours_back: int = Query(72, description="Hours to hindcast into past"),
):
    """Self-improving tide prediction with auto-refit and bias correction."""
    _validate_mmsi(mmsi)
    from tidal_cache import get_prediction
    result = await get_prediction(mmsi, hours_ahead, hours_back)
    if "error" in result:
        raise HTTPException(400, result["error"])
    return result


# ── VIRTUAL STATIONS ──

@router.get("/virtual-stations")
async def list_virtual_stations():
    pool = await db.get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch("SELECT * FROM virtual_stations ORDER BY id")
        result = []
        for r in rows:
            d = dict(r)
            d["created_at"] = d["created_at"].isoformat() if d["created_at"] else None
            # Count manual observations
            obs_count = await conn.fetchval(
                "SELECT COUNT(*) FROM manual_obs WHERE station_id=$1", r["id"])
            d["obs_count"] = obs_count
            d["promoted"] = r["promoted_mmsi"] is not None
            result.append(d)
    return result


@router.post("/virtual-stations")
async def create_virtual_station(
    name: str = Query(...),
    lat: float = Query(...),
    lon: float = Query(...),
    source_mmsis: str = Query(..., description="Comma-separated MMSIs"),
):
    pool = await db.get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "INSERT INTO virtual_stations (name, lat, lon, source_mmsis) "
            "VALUES ($1,$2,$3,$4) RETURNING *",
            name, lat, lon, source_mmsis)
    return dict(row)


@router.delete("/virtual-stations/{station_id}")
async def delete_virtual_station(station_id: int):
    pool = await db.get_pool()
    async with pool.acquire() as conn:
        await conn.execute("DELETE FROM manual_obs WHERE station_id=$1", station_id)
        await conn.execute("DELETE FROM virtual_stations WHERE id=$1", station_id)
    return {"status": "deleted"}


@router.post("/virtual-stations/{station_id}/obs")
async def add_manual_obs(
    station_id: int,
    ts: str = Query(..., description="ISO timestamp"),
    waterlevel: float = Query(...),
    note: str = Query(""),
):
    """Add a manual water level measurement."""
    pool = await db.get_pool()
    async with pool.acquire() as conn:
        vs = await conn.fetchrow("SELECT * FROM virtual_stations WHERE id=$1", station_id)
        if not vs:
            raise HTTPException(404, "Virtual station not found")
        await conn.execute(
            "INSERT INTO manual_obs (station_id, ts, waterlevel, note) VALUES ($1,$2,$3,$4)",
            station_id, datetime.fromisoformat(ts), waterlevel, note)
    return {"status": "ok"}


@router.get("/virtual-stations/{station_id}/obs")
async def get_manual_obs(station_id: int, limit: int = Query(500)):
    pool = await db.get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT ts, waterlevel, note FROM manual_obs WHERE station_id=$1 ORDER BY ts DESC LIMIT $2",
            station_id, _clamp_limit(limit))
    return [{"ts": r["ts"].isoformat(), "waterlevel": r["waterlevel"], "note": r["note"]} for r in rows]


@router.post("/virtual-stations/{station_id}/promote")
async def promote_virtual_station(station_id: int):
    """Promote virtual station to real station once enough manual obs exist (≥48)."""
    pool = await db.get_pool()
    async with pool.acquire() as conn:
        vs = await conn.fetchrow("SELECT * FROM virtual_stations WHERE id=$1", station_id)
        if not vs:
            raise HTTPException(404, "Virtual station not found")
        obs_count = await conn.fetchval("SELECT COUNT(*) FROM manual_obs WHERE station_id=$1", station_id)
        if obs_count < 48:
            raise HTTPException(400, f"Need ≥48 observations to promote, got {obs_count}")

        # Create a pseudo-MMSI (900000000 + station_id)
        mmsi = 900000000 + station_id
        await conn.execute(
            "INSERT INTO stations (mmsi, lon, lat, country) VALUES ($1,$2,$3,$4) "
            "ON CONFLICT (mmsi) DO NOTHING",
            mmsi, vs["lon"], vs["lat"], "Virtual")
        # Copy manual obs to hydro_obs
        obs = await conn.fetch("SELECT ts, waterlevel FROM manual_obs WHERE station_id=$1 ORDER BY ts", station_id)
        await conn.executemany(
            "INSERT INTO hydro_obs (mmsi, ts, waterlevel) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
            [(mmsi, r["ts"], r["waterlevel"]) for r in obs])
        await conn.execute("UPDATE virtual_stations SET promoted_mmsi=$1 WHERE id=$2", mmsi, station_id)
    return {"status": "promoted", "mmsi": mmsi, "obs_copied": obs_count}


@router.get("/tidal/virtual/{station_id}")
async def tidal_virtual_predict(
    station_id: int,
    hours_ahead: int = Query(48),
    hours_back: int = Query(72),
):
    """Predict tide at virtual station — uses own data if promoted, else interpolates."""
    import math
    pool = await db.get_pool()
    async with pool.acquire() as conn:
        vs = await conn.fetchrow("SELECT * FROM virtual_stations WHERE id=$1", station_id)
    if not vs:
        raise HTTPException(404, "Virtual station not found")

    # If promoted, use the real tidal prediction
    if vs["promoted_mmsi"]:
        from tidal_cache import get_prediction
        result = await get_prediction(vs["promoted_mmsi"], hours_ahead, hours_back)
        if "error" not in result:
            result["name"] = vs["name"]
            result["virtual_station_id"] = station_id
            result["mode"] = "own_model"
            return result

    # Otherwise interpolate from source stations
    from tidal_cache import get_prediction
    mmsi_list = [int(m.strip()) for m in vs["source_mmsis"].split(",") if m.strip()]
    lat, lon = vs["lat"], vs["lon"]

    preds = {}
    weights = {}
    for mmsi in mmsi_list:
        result = await get_prediction(mmsi, hours_ahead, hours_back)
        if "error" in result:
            continue
        preds[mmsi] = {p["ts"]: p["level"] for p in result["predictions"]}
        async with pool.acquire() as conn:
            row = await conn.fetchrow("SELECT lat, lon FROM stations WHERE mmsi=$1", mmsi)
        if row:
            dlat = (lat - row["lat"]) * 111.32
            dlon = (lon - row["lon"]) * 111.32 * math.cos(math.radians(lat))
            d = max(math.sqrt(dlat**2 + dlon**2), 0.1)
            weights[mmsi] = 1.0 / d

    if not preds:
        raise HTTPException(400, "No valid source predictions")

    total_w = sum(weights.values())
    for k in weights:
        weights[k] /= total_w

    # Aligned 10-min grid
    from datetime import datetime as _dt, timedelta as _td
    all_starts = [min(p.keys()) for p in preds.values()]
    all_ends = [max(p.keys()) for p in preds.values()]
    t = _dt.fromisoformat(max(all_starts))
    t_end = _dt.fromisoformat(min(all_ends))
    predictions = []
    while t <= t_end:
        tk = t.isoformat()[:16]
        level = 0.0
        ws = 0.0
        for mk, pd in preds.items():
            for pk, pv in pd.items():
                if pk[:16] == tk:
                    level += weights[mk] * pv
                    ws += weights[mk]
                    break
        if ws > 0:
            predictions.append({"ts": t.isoformat(), "level": round(level / ws, 4)})
        t += _td(minutes=10)

    return {
        "name": vs["name"],
        "lat": lat,
        "lon": lon,
        "virtual_station_id": station_id,
        "mode": "interpolated",
        "sources": {str(m): round(weights.get(m, 0), 3) for m in mmsi_list if m in weights},
        "predictions": predictions,
        "predict_end": predictions[-1]["ts"] if predictions else None,
    }


@router.get("/station-names")
async def station_names():
    """Fetch shipnames from AIS ships_array and map to our station MMSIs."""
    cached = _cached("station_names")
    if cached:
        return cached
    pool = await db.get_pool()
    async with pool.acquire() as conn:
        mmsis = [r["mmsi"] for r in await conn.fetch("SELECT mmsi FROM stations")]
    mmsi_set = set(mmsis)
    names = {}
    try:
        import httpx
        async with httpx.AsyncClient() as client:
            for src_url in ["https://aisinfra.hpradar.com", "https://m3.hpradar.com", "https://m4.hpradar.com"]:
                try:
                    resp = await client.get(f"{src_url}/api/ships_array.json", timeout=15.0)
                    if resp.status_code != 200:
                        continue
                    raw = resp.json()
                    rows = raw.get("values", raw) if isinstance(raw, dict) else raw
                    for row in rows:
                        if len(row) > 31 and row[0] in mmsi_set and row[31]:
                            name = str(row[31]).strip()
                            if name and len(name) > 1:
                                names[str(row[0])] = name
                except Exception:
                    continue
    except Exception:
        pass
    _set_cache("station_names", names)
    return names


@router.get("/alerts")
async def get_alerts():
    """List active alerts and recent events (Phase 6 item 28)."""
    pool = await db.get_pool()
    async with pool.acquire() as conn:
        alerts = await conn.fetch("SELECT * FROM alerts WHERE active = TRUE ORDER BY id")
        events = await conn.fetch(
            "SELECT * FROM alert_events ORDER BY triggered_at DESC LIMIT 100")
    return {
        "alerts": [dict(r) for r in alerts],
        "recent_events": [
            {**dict(r), "ts": r["ts"].isoformat() if r["ts"] else None,
             "triggered_at": r["triggered_at"].isoformat() if r["triggered_at"] else None}
            for r in events
        ],
    }


@router.post("/alerts")
async def create_alert(
    mmsi: Optional[int] = Query(None),
    field: str = Query(..., description="Field: waterlevel, wspeed, wdir, seastate"),
    operator: str = Query(">", description="Operator: >, <, >=, <=, ="),
    threshold: float = Query(...),
):
    """Create a threshold alert."""
    if field not in ("waterlevel", "wspeed", "wdir", "seastate"):
        raise HTTPException(400, "field must be one of: waterlevel, wspeed, wdir, seastate")
    if operator not in (">", "<", ">=", "<=", "="):
        raise HTTPException(400, "operator must be one of: >, <, >=, <=, =")
    pool = await db.get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "INSERT INTO alerts (mmsi, field, operator, threshold) VALUES ($1,$2,$3,$4) RETURNING *",
            mmsi, field, operator, threshold)
    return dict(row)


@router.delete("/alerts/{alert_id}")
async def delete_alert(alert_id: int):
    pool = await db.get_pool()
    async with pool.acquire() as conn:
        await conn.execute("UPDATE alerts SET active = FALSE WHERE id = $1", alert_id)
    return {"status": "deactivated"}


def _build_filters(mmsi, start, end):
    """Build WHERE clause with parameterized filters."""
    conditions = []
    params = []
    idx = 1
    if mmsi:
        conditions.append(f"mmsi=${idx}")
        params.append(mmsi)
        idx += 1
    if start:
        conditions.append(f"ts >= ${idx}")
        params.append(datetime.fromisoformat(start))
        idx += 1
    if end:
        conditions.append(f"ts <= ${idx}")
        params.append(datetime.fromisoformat(end))
        idx += 1
    clause = ("WHERE " + " AND ".join(conditions)) if conditions else ""
    return clause, params
