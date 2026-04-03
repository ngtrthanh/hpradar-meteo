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
# Rolling last-known waterlevel per MMSI for spike detection
_last_wl: dict[int, float] = {}
SPIKE_THRESHOLD = 1.0  # metres — max plausible change between consecutive readings


async def start():
    """Start one poller task per source (each with its own interval)."""
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
    """Manual one-shot fetch from all sources."""
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

    # Spike filter: reject waterlevel readings that jump >1m from last known value
    clean = []
    spikes = 0
    for p in unique:
        if p.waterlevel is not None and p.mmsi in _last_wl:
            if abs(p.waterlevel - _last_wl[p.mmsi]) > SPIKE_THRESHOLD:
                spikes += 1
                p = p.model_copy(update={"waterlevel": None})  # strip bad waterlevel, keep meteo
        if p.waterlevel is not None:
            _last_wl[p.mmsi] = p.waterlevel
        # Keep point if it still has any useful data
        if p.wspeed is not None or p.wdir is not None or p.waterlevel is not None:
            clean.append(p)
    if spikes:
        stats["spikes_filtered"] = spikes

    if clean:
        await db.batch_upsert(clean)
        await ws.broadcast(clean)

    logger.info("Source %s: %d msgs, %d clean, stats=%s",
                url, len(arr), len(clean), dict(stats))
