import logging
import asyncio
from collections import Counter, defaultdict

import httpx

import config
import db
import ws
from parser import parse_message

logger = logging.getLogger(__name__)

_tasks: list[asyncio.Task] = []
# Rolling last-known waterlevel per MMSI for spike detection: {mmsi: (waterlevel, timestamp)}
_last_wl: dict[int, tuple[float, object]] = {}
SPIKE_THRESHOLD = 1.0  # metres
MAX_RATE = 6.0  # metres/hour


async def start():
    global _tasks
    for src in config.SOURCES:
        t = asyncio.create_task(_source_loop(src["url"], src["interval"]))
        _tasks.append(t)
    logger.info("Poller started — %d source(s)", len(config.SOURCES))


async def stop():
    for t in _tasks:
        t.cancel()
    await asyncio.gather(*_tasks, return_exceptions=True)
    _tasks.clear()


def is_running() -> bool:
    return bool(_tasks) and any(not t.done() for t in _tasks)


async def fetch_once():
    async with httpx.AsyncClient() as client:
        for src in config.SOURCES:
            await _fetch_source(client, src["url"])


async def _source_loop(url: str, interval: float):
    logger.info("Source loop: %s every %ss", url, interval)
    async with httpx.AsyncClient() as client:
        while True:
            try:
                await _fetch_source(client, url)
            except Exception as e:
                logger.error("Source %s error: %s", url, e)
            await asyncio.sleep(interval)


async def _fetch_source(client: httpx.AsyncClient, url: str):
    resp = await client.get(url, timeout=30.0)
    resp.raise_for_status()
    arr = resp.json()
    if not isinstance(arr, list):
        return

    stats = Counter()
    points = []
    for obj in arr:
        point, reason = parse_message(obj)
        if point:
            points.append(point)
            stats["parsed"] += 1
        else:
            stats[reason] += 1

    # Deduplicate
    seen = set()
    unique = []
    for p in points:
        key = (p.mmsi, p.ts)
        if key not in seen:
            seen.add(key)
            unique.append(p)

    # Quality flag: 0=good, 1=suspect, 2=spike (store all, flag bad)
    flagged = []
    spikes = 0
    for p in unique:
        qf = 0
        if p.waterlevel is not None and p.mmsi in _last_wl:
            prev_wl, prev_ts = _last_wl[p.mmsi]
            delta = abs(p.waterlevel - prev_wl)
            gap_hr = max((p.ts - prev_ts).total_seconds() / 3600, 0.001)
            rate = delta / gap_hr
            if delta > SPIKE_THRESHOLD and rate > MAX_RATE:
                qf = 2
                spikes += 1
        if p.waterlevel is not None and qf == 0:
            _last_wl[p.mmsi] = (p.waterlevel, p.ts)
        flagged.append((p, qf))
    if spikes:
        stats["spikes"] = spikes

    if flagged:
        await db.batch_upsert_flagged(flagged)
        await ws.broadcast([p for p, q in flagged if q == 0])

    logger.info("Source %s: %d msgs, %d stored (%d spikes), stats=%s",
                url, len(arr), len(flagged), spikes, dict(stats))
