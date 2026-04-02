import time
import logging
from typing import Optional
from datetime import datetime

from fastapi import APIRouter, HTTPException, Query, Request, WebSocket, WebSocketDisconnect

import config
import db
import poller
import ws as wshub

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api")

# Simple in-memory cache (Phase 2 item 8)
_cache: dict[str, tuple[float, object]] = {}
CACHE_TTL = 180  # seconds, matches poll interval


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
async def get_counts(exact: bool = Query(False)):
    """Record counts. Use ?exact=true for precise counts (Phase 2 item 9)."""
    cached = _cached("counts")
    if cached and not exact:
        return cached

    pool = await db.get_pool()
    async with pool.acquire() as conn:
        if exact:
            s = await conn.fetchval("SELECT COUNT(*) FROM stations")
            m = await conn.fetchval("SELECT COUNT(*) FROM meteo_obs")
            h = await conn.fetchval("SELECT COUNT(*) FROM hydro_obs")
        else:
            s = await conn.fetchval(
                "SELECT reltuples::bigint FROM pg_class WHERE relname='stations'")
            m = await conn.fetchval(
                "SELECT reltuples::bigint FROM pg_class WHERE relname='meteo_obs'")
            h = await conn.fetchval(
                "SELECT reltuples::bigint FROM pg_class WHERE relname='hydro_obs'")

    result = {"stations": s or 0, "meteo_observations": m or 0, "hydro_observations": h or 0}
    _set_cache("counts", result)
    return result


@router.get("/stations")
async def get_stations(limit: int = Query(1000)):
    pool = await db.get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT s.mmsi, s.dac, s.fi, s.lon, s.lat, s.country,
                   (SELECT COUNT(*) > 0 FROM meteo_obs m WHERE m.mmsi = s.mmsi) AS has_meteo,
                   (SELECT COUNT(*) > 0 FROM hydro_obs h WHERE h.mmsi = s.mmsi) AS has_hydro
            FROM stations s ORDER BY s.mmsi LIMIT $1
        """, _clamp_limit(limit))
        return [dict(r) for r in rows]


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
            "SELECT ts, wspeed, wdir, quality FROM meteo_obs WHERE mmsi=$1 ORDER BY ts DESC LIMIT 1", mmsi)
        latest_hydro = await conn.fetchrow(
            "SELECT ts, waterlevel, seastate, quality FROM hydro_obs WHERE mmsi=$1 ORDER BY ts DESC LIMIT 1", mmsi)
        meteo_count = await conn.fetchval("SELECT COUNT(*) FROM meteo_obs WHERE mmsi=$1", mmsi)
        hydro_count = await conn.fetchval("SELECT COUNT(*) FROM hydro_obs WHERE mmsi=$1", mmsi)
        quality_dist = await conn.fetch(
            "SELECT quality, COUNT(*) as cnt FROM meteo_obs WHERE mmsi=$1 GROUP BY quality "
            "UNION ALL "
            "SELECT quality, COUNT(*) as cnt FROM hydro_obs WHERE mmsi=$1 GROUP BY quality", mmsi, mmsi)

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
        "quality_distribution": [dict(r) for r in quality_dist],
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
