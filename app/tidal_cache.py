"""Self-improving tidal prediction cache.

Stores harmonic analysis per station, auto-refits when:
1. No cached analysis exists
2. Cache is older than REFIT_HOURS
3. Prediction accuracy degrades (RMSE of recent obs vs pred > threshold)

Bias correction is applied continuously from the last 6h of observed data.
"""

import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Optional

logger = logging.getLogger(__name__)

# Config
REFIT_HOURS = 6          # Re-analyze every 6 hours
ACCURACY_CHECK_PTS = 30  # Compare last N observed points against prediction
DEGRADE_FACTOR = 2.0     # Trigger refit if recent RMSE > DEGRADE_FACTOR * training RMSE

# Cache: {mmsi: {analysis, fitted_at, last_check, bias, n_obs_at_fit}}
_cache: dict[int, dict] = {}


async def get_prediction(mmsi: int, hours_ahead: int = 48, hours_back: int = 72) -> dict:
    """Get prediction with auto-refit and bias correction."""
    import db
    from tidal import analyze, predict

    pool = await db.get_pool()
    now = datetime.now(timezone.utc)

    # Fetch observed data
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT ts, waterlevel FROM hydro_obs WHERE mmsi=$1 AND waterlevel IS NOT NULL "
            "ORDER BY ts ASC", mmsi)
    if len(rows) < 48:
        return {"error": f"Need ≥48 points, got {len(rows)}"}

    times = [r["ts"] for r in rows]
    values = [float(r["waterlevel"]) for r in rows]

    # Check if we need to (re)fit
    entry = _cache.get(mmsi)
    need_refit = (
        entry is None
        or (time.time() - entry["fitted_at"]) > REFIT_HOURS * 3600
        or len(rows) > entry.get("n_obs_at_fit", 0) * 1.1  # 10% more data
        or _check_degraded(entry, times, values)
    )

    if need_refit:
        logger.info("Tidal refit for MMSI %d (%s)", mmsi,
                     "initial" if entry is None else "scheduled" if not _check_degraded(entry, times, values) else "degraded")
        # Subsample if too dense
        fit_times, fit_values = times, values
        if len(fit_times) > 20000:
            step = max(1, len(fit_times) // 20000)
            fit_times = fit_times[::step]
            fit_values = fit_values[::step]

        try:
            analysis = analyze(fit_times, fit_values)
            _cache[mmsi] = {
                "analysis": analysis,
                "fitted_at": time.time(),
                "n_obs_at_fit": len(rows),
                "training_rmse": analysis["rmse"],
            }
            entry = _cache[mmsi]
        except Exception as e:
            logger.error("Tidal analysis failed for %d: %s", mmsi, e)
            if entry is None:
                return {"error": str(e)}
            # Use stale cache if refit fails

    analysis = entry["analysis"]
    last_obs_time = times[-1]

    # Generate prediction
    hind_start = last_obs_time - timedelta(hours=hours_back)
    fore_end = last_obs_time + timedelta(hours=hours_ahead)
    all_pred = predict(analysis, hind_start, fore_end, interval_min=10)

    # Bias correction from last 6h
    bias = _compute_bias(analysis, times, values, last_obs_time)
    if bias != 0:
        for p in all_pred:
            p["level"] = round(p["level"] + bias, 4)

    # Compute recent accuracy (for display)
    recent_rmse = _recent_rmse(all_pred, times, values, last_obs_time)

    return {
        "mmsi": mmsi,
        "r2": analysis["r2"],
        "rmse": analysis["rmse"],
        "recent_rmse": round(recent_rmse, 4) if recent_rmse else None,
        "bias": round(bias, 4),
        "n_constituents": analysis["n_constituents"],
        "observed_start": hind_start.isoformat(),
        "observed_end": last_obs_time.isoformat(),
        "predict_end": fore_end.isoformat(),
        "predictions": all_pred,
        "fitted_ago_min": round((time.time() - entry["fitted_at"]) / 60),
        "top_constituents": sorted(
            analysis["constituents"].items(),
            key=lambda x: x[1]["amp"], reverse=True
        )[:10],
    }


def _compute_bias(analysis, times, values, last_obs_time) -> float:
    """Compute mean offset between recent observed and predicted."""
    from tidal import predict
    cutoff = last_obs_time - timedelta(hours=6)
    recent = [(t, v) for t, v in zip(times, values) if t >= cutoff]
    if len(recent) < 6:
        return 0.0

    preds = predict(analysis, cutoff, last_obs_time, interval_min=5)
    pred_lookup = {}
    for p in preds:
        # Round to nearest minute for matching
        key = p["ts"][:16]
        pred_lookup[key] = p["level"]

    diffs = []
    for t, v in recent:
        key = t.isoformat()[:16]
        if key in pred_lookup:
            diffs.append(v - pred_lookup[key])

    return sum(diffs) / len(diffs) if diffs else 0.0


def _recent_rmse(all_pred, times, values, last_obs_time) -> Optional[float]:
    """RMSE of prediction vs observed over last 6h."""
    import math
    cutoff = last_obs_time - timedelta(hours=6)
    pred_lookup = {p["ts"][:16]: p["level"] for p in all_pred}
    sq_errors = []
    for t, v in zip(times, values):
        if t >= cutoff:
            key = t.isoformat()[:16]
            if key in pred_lookup:
                sq_errors.append((v - pred_lookup[key]) ** 2)
    if len(sq_errors) < 3:
        return None
    return math.sqrt(sum(sq_errors) / len(sq_errors))


def _check_degraded(entry: Optional[dict], times, values) -> bool:
    """Check if cached model has degraded."""
    if entry is None:
        return True
    analysis = entry["analysis"]
    last_obs_time = times[-1]
    rmse = _recent_rmse_from_analysis(analysis, times, values, last_obs_time)
    if rmse is None:
        return False
    return rmse > entry.get("training_rmse", 999) * DEGRADE_FACTOR


def _recent_rmse_from_analysis(analysis, times, values, last_obs_time) -> Optional[float]:
    """Quick RMSE check without generating full prediction array."""
    import math
    from tidal import predict
    cutoff = last_obs_time - timedelta(hours=3)
    recent = [(t, v) for t, v in zip(times, values) if t >= cutoff]
    if len(recent) < 6:
        return None
    preds = predict(analysis, cutoff, last_obs_time, interval_min=5)
    pred_lookup = {p["ts"][:16]: p["level"] for p in preds}
    sq = []
    for t, v in recent:
        key = t.isoformat()[:16]
        if key in pred_lookup:
            sq.append((v - pred_lookup[key]) ** 2)
    return math.sqrt(sum(sq) / len(sq)) if sq else None
