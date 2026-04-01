"""Data quality checks (Phase 6 item 27).

Returns a quality score 0-3:
  0 = good
  1 = suspect (near physical bounds)
  2 = bad (outside physical bounds)
  3 = missing key fields
"""

from models import MeteoHydroPoint

# Physical bounds
WSPEED_MAX = 80.0       # m/s (category 5 hurricane ~70)
WDIR_MIN, WDIR_MAX = 0, 360
WATERLEVEL_MIN = -15.0  # metres (lowest astronomical tide)
WATERLEVEL_MAX = 30.0   # metres (extreme storm surge)
SEASTATE_MAX = 9


def check_quality(p: MeteoHydroPoint) -> int:
    """Return quality flag for a data point."""
    # Missing both meteo and hydro
    if (p.wspeed is None and p.wdir is None and
            p.waterlevel is None and p.seastate is None):
        return 3

    score = 0

    if p.wspeed is not None:
        if p.wspeed < 0 or p.wspeed > WSPEED_MAX:
            score = max(score, 2)
        elif p.wspeed > WSPEED_MAX * 0.8:
            score = max(score, 1)

    if p.wdir is not None:
        if p.wdir < WDIR_MIN or p.wdir >= WDIR_MAX:
            score = max(score, 2)

    if p.waterlevel is not None:
        if p.waterlevel < WATERLEVEL_MIN or p.waterlevel > WATERLEVEL_MAX:
            score = max(score, 2)
        elif abs(p.waterlevel) > WATERLEVEL_MAX * 0.8:
            score = max(score, 1)

    if p.seastate is not None:
        if p.seastate < 0 or p.seastate > SEASTATE_MAX:
            score = max(score, 2)

    return score
