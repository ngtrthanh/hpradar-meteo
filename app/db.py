import logging
import asyncio
from typing import Optional

import asyncpg

import config

logger = logging.getLogger(__name__)

_pool: Optional[asyncpg.Pool] = None


async def get_pool() -> asyncpg.Pool:
    global _pool
    if _pool:
        return _pool
    _pool = await _init_pool()
    return _pool


async def _init_pool(retries: int = 5, delay: float = 3.0) -> asyncpg.Pool:
    """Create pool with exponential-backoff retry (Phase 3 item 13)."""
    for attempt in range(1, retries + 1):
        try:
            pool = await asyncpg.create_pool(
                host=config.DB_HOST, port=config.DB_PORT,
                database=config.DB_NAME, user=config.DB_USER, password=config.DB_PASS,
                min_size=1, max_size=5,
            )
            logger.info("Database pool created (attempt %d)", attempt)
            await _ensure_schema(pool)
            return pool
        except Exception as e:
            logger.warning("DB connect attempt %d/%d failed: %s", attempt, retries, e)
            if attempt == retries:
                raise
            await asyncio.sleep(delay * attempt)


async def _ensure_schema(pool: asyncpg.Pool):
    async with pool.acquire() as conn:
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS stations (
                mmsi BIGINT PRIMARY KEY,
                dac INT, fi INT,
                lon DOUBLE PRECISION, lat DOUBLE PRECISION,
                country TEXT
            );
        """)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS meteo_obs (
                mmsi BIGINT REFERENCES stations(mmsi) ON DELETE CASCADE,
                ts TIMESTAMPTZ NOT NULL,
                wspeed DOUBLE PRECISION, wdir INT,
                PRIMARY KEY (mmsi, ts)
            );
        """)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS hydro_obs (
                mmsi BIGINT REFERENCES stations(mmsi) ON DELETE CASCADE,
                ts TIMESTAMPTZ NOT NULL,
                waterlevel DOUBLE PRECISION, seastate INT,
                PRIMARY KEY (mmsi, ts)
            );
        """)

        # Optional migrations — may fail on permission-restricted DBs
        _optional = [
            "ALTER TABLE meteo_obs ADD COLUMN IF NOT EXISTS quality SMALLINT DEFAULT 0",
            "ALTER TABLE hydro_obs ADD COLUMN IF NOT EXISTS quality SMALLINT DEFAULT 0",
            "CREATE INDEX IF NOT EXISTS idx_meteo_ts ON meteo_obs (ts DESC)",
            "CREATE INDEX IF NOT EXISTS idx_hydro_ts ON hydro_obs (ts DESC)",
            """CREATE TABLE IF NOT EXISTS alerts (
                id SERIAL PRIMARY KEY, mmsi BIGINT,
                field TEXT NOT NULL, operator TEXT NOT NULL DEFAULT '>',
                threshold DOUBLE PRECISION NOT NULL,
                active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW())""",
            """CREATE TABLE IF NOT EXISTS alert_events (
                id SERIAL PRIMARY KEY,
                alert_id INT REFERENCES alerts(id) ON DELETE CASCADE,
                mmsi BIGINT, ts TIMESTAMPTZ,
                value DOUBLE PRECISION, triggered_at TIMESTAMPTZ DEFAULT NOW())""",
        ]
        for sql in _optional:
            try:
                await conn.execute(sql)
            except Exception as e:
                logger.warning("Optional migration skipped: %s", e)

        # TimescaleDB hypertables + retention (Phase 2 item 7)
        try:
            await conn.execute("SELECT create_hypertable('meteo_obs','ts', if_not_exists=>TRUE);")
            await conn.execute("SELECT create_hypertable('hydro_obs','ts', if_not_exists=>TRUE);")
            await conn.execute(
                f"SELECT add_retention_policy('meteo_obs', INTERVAL '{config.RETENTION_DAYS} days', if_not_exists=>TRUE);"
            )
            await conn.execute(
                f"SELECT add_retention_policy('hydro_obs', INTERVAL '{config.RETENTION_DAYS} days', if_not_exists=>TRUE);"
            )
            logger.info("TimescaleDB hypertables + retention ready")
        except Exception as e:
            logger.warning("TimescaleDB setup skipped: %s", e)

    logger.info("Schema ready")


async def batch_upsert(points):
    """Batch insert using executemany — Phase 2 item 5."""
    if not points:
        return
    from quality import check_quality

    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            # Stations upsert
            await conn.executemany("""
                INSERT INTO stations (mmsi, dac, fi, lon, lat, country)
                VALUES ($1,$2,$3,$4,$5,$6)
                ON CONFLICT (mmsi) DO UPDATE
                  SET dac=EXCLUDED.dac, fi=EXCLUDED.fi, lon=EXCLUDED.lon,
                      lat=EXCLUDED.lat, country=EXCLUDED.country
            """, [(p.mmsi, p.dac, p.fi, p.lon, p.lat, p.country) for p in points])

            # Meteo batch with quality
            meteo = [(p.mmsi, p.ts, p.wspeed, p.wdir)
                     for p in points if p.wspeed is not None or p.wdir is not None]
            if meteo:
                await conn.executemany("""
                    INSERT INTO meteo_obs (mmsi, ts, wspeed, wdir)
                    VALUES ($1,$2,$3,$4)
                    ON CONFLICT (mmsi, ts) DO NOTHING
                """, meteo)

            # Hydro batch with quality
            hydro = [(p.mmsi, p.ts, p.waterlevel, p.seastate)
                     for p in points if p.waterlevel is not None or p.seastate is not None]
            if hydro:
                await conn.executemany("""
                    INSERT INTO hydro_obs (mmsi, ts, waterlevel, seastate)
                    VALUES ($1,$2,$3,$4)
                    ON CONFLICT (mmsi, ts) DO NOTHING
                """, hydro)

    logger.info("Batch insert: %d stations, %d meteo, %d hydro",
                len(points), len(meteo) if meteo else 0,
                len(hydro) if hydro else 0)

    # Check alerts (Phase 6 item 28)
    await _check_alerts(points)


async def _check_alerts(points):
    """Check active alerts against new data points."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        alerts = await conn.fetch("SELECT id, mmsi, field, operator, threshold FROM alerts WHERE active = TRUE")
        if not alerts:
            return

        events = []
        for a in alerts:
            for p in points:
                if a["mmsi"] is not None and a["mmsi"] != p.mmsi:
                    continue
                val = getattr(p, a["field"], None)
                if val is None:
                    continue
                op = a["operator"]
                triggered = (
                    (op == ">" and val > a["threshold"]) or
                    (op == "<" and val < a["threshold"]) or
                    (op == ">=" and val >= a["threshold"]) or
                    (op == "<=" and val <= a["threshold"]) or
                    (op == "=" and val == a["threshold"])
                )
                if triggered:
                    events.append((a["id"], p.mmsi, p.ts, float(val)))

        if events:
            await conn.executemany("""
                INSERT INTO alert_events (alert_id, mmsi, ts, value)
                VALUES ($1, $2, $3, $4)
            """, events)
            logger.info("Triggered %d alert events", len(events))


async def close_pool():
    global _pool
    if _pool:
        await _pool.close()
        _pool = None
