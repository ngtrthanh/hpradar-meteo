import logging
import asyncio
from collections import Counter

import httpx

import config
import db
from parser import parse_message

logger = logging.getLogger(__name__)

_task = None


async def start():
    global _task
    _task = asyncio.create_task(_poll_loop())


async def stop():
    if _task:
        _task.cancel()
        try:
            await _task
        except asyncio.CancelledError:
            pass


def is_running() -> bool:
    return _task is not None and not _task.done()


async def fetch_once():
    """Single fetch cycle across all configured sources."""
    async with httpx.AsyncClient() as client:
        await _fetch_all(client)


async def _poll_loop():
    logger.info("Poller started — %d source(s), interval %ss",
                len(config.FETCH_URLS), config.POLL_INTERVAL)
    async with httpx.AsyncClient() as client:
        while True:
            try:
                await _fetch_all(client)
            except Exception as e:
                logger.error("Poller cycle error: %s", e, exc_info=True)
            await asyncio.sleep(config.POLL_INTERVAL)


async def _fetch_all(client: httpx.AsyncClient):
    """Fetch from every source, merge, deduplicate, batch-insert."""
    all_points = []
    total_stats = Counter()

    for url in config.FETCH_URLS:
        try:
            resp = await client.get(url, timeout=30.0)
            resp.raise_for_status()
            arr = resp.json()
            if not isinstance(arr, list):
                logger.warning("Non-list from %s", url)
                continue

            stats = Counter()
            for obj in arr:
                point, reason = parse_message(obj)
                if point:
                    all_points.append(point)
                    stats["parsed"] += 1
                else:
                    stats[reason] += 1

            total_stats += stats
            logger.info("Source %s: %d msgs, %d parsed", url, len(arr), stats["parsed"])

        except Exception as e:
            logger.error("Fetch failed for %s: %s", url, e)
            total_stats["fetch_errors"] += 1

    # Deduplicate by (mmsi, ts)
    seen = set()
    unique = []
    for p in all_points:
        key = (p.mmsi, p.ts)
        if key not in seen:
            seen.add(key)
            unique.append(p)

    if unique:
        await db.batch_upsert(unique)

    logger.info("Cycle done: %d unique points from %d total, stats=%s",
                len(unique), len(all_points), dict(total_stats))
