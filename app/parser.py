import logging
from typing import Optional
from datetime import datetime, timezone

from models import MeteoHydroPoint

logger = logging.getLogger(__name__)


class Rejection:
    WRONG_TYPE = "wrong_type"
    WRONG_DAC = "wrong_dac"
    WRONG_FID = "wrong_fid"
    NOT_SCALED = "not_scaled"
    NO_COORDS = "no_coords"
    BAD_MMSI = "bad_mmsi"
    NO_TIMESTAMP = "no_timestamp"
    NO_DATA = "no_data"


def parse_message(obj: dict) -> tuple[Optional[MeteoHydroPoint], Optional[str]]:
    """Parse an AIS message dict. Returns (point, None) on success or (None, reason)."""
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

        # Parse timestamp — try object level then message level
        ts = _parse_ts(obj) or _parse_ts(msg)
        if not ts:
            ts = datetime.now(timezone.utc)

        wspeed = msg.get("wspeed")
        wdir = msg.get("wdir")
        waterlevel = msg.get("waterlevel")
        seastate = msg.get("seastate")

        # Strip AIS "not available" sentinel values (IMO Circ.289)
        if seastate is not None and seastate >= 13:
            seastate = None
        if wspeed is not None and wspeed >= 127:
            wspeed = None
        if wdir is not None and wdir >= 360:
            wdir = None
        if waterlevel is not None and (waterlevel >= 327 or waterlevel <= -327):
            waterlevel = None

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
