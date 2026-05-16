import logging
import asyncio
from collections import Counter

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

# Per-source state for upstream short-circuiting:
#   _last_max_ts[url] — highest message timestamp we've already processed
#   _last_modified[url] — Last-Modified header value to send as If-Modified-Since
_last_max_ts: dict[str, int] = {}
_last_modified: dict[str, str] = {}


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
    headers = {}
    if url in _last_modified:
        headers["If-Modified-Since"] = _last_modified[url]

    resp = await client.get(url, timeout=30.0, headers=headers)

    # Upstream-confirmed cache hit: nothing changed since last poll.
    if resp.status_code == 304:
        logger.info("Source %s: not_modified (304)", url)
        return

    resp.raise_for_status()

    # Remember the upstream Last-Modified for the next If-Modified-Since.
    lm = resp.headers.get("last-modified")
    if lm:
        _last_modified[url] = lm

    arr = resp.json()
    if not isinstance(arr, list):
        return

    # App-level cache short-circuit: if the highest message timestamp in this
    # response is the same as last time, nothing new to process. Avoids
    # parse + dedup + DB round-trip when upstream serves no-cache headers.
    max_ts = 0
    for obj in arr:
        ts = obj.get("timestamp") or obj.get("message", {}).get("timestamp") or 0
        if isinstance(ts, (int, float)) and ts > max_ts:
            max_ts = int(ts)

    prev = _last_max_ts.get(url, 0)
    if max_ts and max_ts <= prev:
        logger.info("Source %s: cached (max_ts=%d, %d msgs)", url, max_ts, len(arr))
        return
    if max_ts:
        _last_max_ts[url] = max_ts

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
        # Invalidate counts cache
        from routes.api import _cache
        _cache.pop("counts", None)
        _cache.pop("stations", None)

    logger.info("Source %s: %d msgs, %d stored (%d spikes), stats=%s",
                url, len(arr), len(flagged), spikes, dict(stats))
