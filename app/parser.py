import logging
from typing import Optional
from datetime import datetime, timezone

from models import MeteoHydroPoint

logger = logging.getLogger(__name__)

# AIS "not available" sentinel values (IMO Circ.289 / ITU-R M.1371)
_SENTINELS = {
    "seastate": lambda v: v is None or v >= 13,
    "wspeed": lambda v: v is None or v >= 127,
    "wdir": lambda v: v is None or v >= 360,
    "waterlevel": lambda v: v is None or v >= 327 or v <= -327,
}

# Physically impossible values
_BOUNDS = {
    "wspeed": (0, 100),        # m/s — cat 5 hurricane ~70
    "wdir": (0, 359),
    "waterlevel": (-15, 25),   # metres
    "seastate": (0, 9),
}


class Rejection:
    WRONG_TYPE = "wrong_type"
    WRONG_DAC = "wrong_dac"
    WRONG_FID = "wrong_fid"
    NOT_SCALED = "not_scaled"
    NO_COORDS = "no_coords"
    BAD_MMSI = "bad_mmsi"
    NO_DATA = "no_data"
    BAD_QUALITY = "bad_quality"


def parse_message(obj: dict) -> tuple[Optional[MeteoHydroPoint], Optional[str]]:
    """Parse AIS message. Returns (point, None) on success or (None, reason)."""
    try:
        msg = obj.get("message", obj)

        if msg.get("type") != 8:
            return None, Rejection.WRONG_TYPE
        if msg.get("dac") != 1:
            return None, Rejection.WRONG_DAC
        if msg.get("fid") != 31:
            return None, Rejection.WRONG_FID
        if msg.get("scaled") is False:
            return None, Rejection.NOT_SCALED

        lat = msg.get("lat")
        lon = msg.get("lon")
        if lat is None or lon is None:
            return None, Rejection.NO_COORDS

        mmsi = msg.get("mmsi")
        if not mmsi or mmsi == 0:
            return None, Rejection.BAD_MMSI

        ts = _parse_ts(obj) or _parse_ts(msg)
        if not ts:
            ts = datetime.now(timezone.utc)

        # Extract and clean fields
        wspeed = _clean("wspeed", msg.get("wspeed"))
        wdir = _clean("wdir", msg.get("wdir"))
        waterlevel = _clean("waterlevel", msg.get("waterlevel"))
        seastate = _clean("seastate", msg.get("seastate"))

        # Reject if nothing useful remains
        if wspeed is None and wdir is None and waterlevel is None and seastate is None:
            return None, Rejection.NO_DATA

        point = MeteoHydroPoint(
            mmsi=int(mmsi), dac=msg.get("dac"), fi=msg.get("fid"),
            ts=ts, lon=float(lon), lat=float(lat),
            wspeed=wspeed, wdir=wdir, waterlevel=waterlevel, seastate=seastate,
            country=msg.get("country"), signalpower=msg.get("signalpower"),
        )
        return point, None

    except Exception as e:
        logger.error("Parse error: %s", e, exc_info=True)
        return None, str(e)


def _clean(field: str, val) -> Optional[float]:
    """Strip sentinel values and out-of-bounds readings. Returns None if bad."""
    if val is None:
        return None
    # Sentinel check
    if _SENTINELS.get(field, lambda v: False)(val):
        return None
    # Bounds check
    bounds = _BOUNDS.get(field)
    if bounds and (val < bounds[0] or val > bounds[1]):
        return None
    return val


def _parse_ts(d: dict) -> Optional[datetime]:
    for field in ("timestamp", "rxtime", "ts"):
        val = d.get(field)
        if val is None:
            continue
        if isinstance(val, (int, float)) and val > 1_000_000_000:
            return datetime.fromtimestamp(val, tz=timezone.utc)
        if isinstance(val, str) and len(val) >= 14:
            try:
                return datetime.strptime(val[:14], "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
            except ValueError:
                pass
    return None
