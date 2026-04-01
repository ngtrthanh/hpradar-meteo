"""WebSocket hub for real-time data push."""

import json
import logging
from datetime import datetime
from fastapi import WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)

_clients: set[WebSocket] = set()


async def connect(ws: WebSocket):
    await ws.accept()
    _clients.add(ws)
    logger.info("WS client connected (%d total)", len(_clients))


async def disconnect(ws: WebSocket):
    _clients.discard(ws)
    logger.info("WS client disconnected (%d total)", len(_clients))


async def broadcast(points):
    """Push new data points to all connected WebSocket clients."""
    if not _clients or not points:
        return
    payload = json.dumps({
        "type": "new_data",
        "count": len(points),
        "ts": datetime.utcnow().isoformat() + "Z",
        "points": [
            {
                "mmsi": p.mmsi, "ts": p.ts.isoformat(),
                "lat": p.lat, "lon": p.lon,
                "wspeed": p.wspeed, "wdir": p.wdir,
                "waterlevel": p.waterlevel, "seastate": p.seastate,
                "country": p.country,
            }
            for p in points[:100]  # cap payload size
        ],
    })
    dead = set()
    for c in _clients.copy():
        try:
            await c.send_text(payload)
        except Exception:
            dead.add(c)
    for c in dead:
        _clients.discard(c)
