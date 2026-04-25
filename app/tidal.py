"""Tidal harmonic analysis and prediction.

Simultaneous least-squares fit of tidal constituents with nodal corrections.
Uses iteratively reweighted least squares (IRLS) for robustness against outliers.
Frequencies from IHO/NOAA standard tables (degrees per hour).
"""

import math
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)

# ── 37 standard tidal constituents (freq in °/hour) ──
CONSTITUENTS = {
    # Semidiurnal
    'M2':      28.9841042,  'S2':      30.0000000,  'N2':      28.4397295,
    'K2':      30.0821373,  'L2':      29.5284789,  'T2':      29.9589333,
    '2N2':     27.8953548,  'MU2':     27.9682084,  'NU2':     28.5125831,
    'LDA2':    29.4556253,  'EPS2':    27.4238337,
    # Diurnal
    'K1':      15.0410686,  'O1':      13.9430356,  'P1':      14.9589314,
    'Q1':      13.3986609,  'J1':      15.5854433,  'OO1':     16.1391017,
    '2Q1':     12.8542862,  'RHO1':    13.4715145,  'M1':      14.4920521,
    'S1':      15.0000000,
    # Long period
    'MF':       1.0980331,  'MM':       0.5443747,  'SSA':      0.0821373,
    'SA':       0.0410686,  'MSF':      1.0158958,
    # Shallow water
    'M4':      57.9682084,  'MS4':     58.9841042,  'MN4':     57.4238337,
    'M6':      86.9523127,  'M8':     115.9364169,  '2MS6':    87.9682084,
    # Terdiurnal
    'M3':      43.4761563,  'MK3':     44.0251729,  'SK3':     45.0410686,
    # Compound
    'MN4':     57.4238337,  'SN4':     58.4397295,
}

# Remove duplicate MN4
_FREQ = {}
for k, v in CONSTITUENTS.items():
    if k not in _FREQ:
        _FREQ[k] = v
CONSTITUENTS = _FREQ


def _node_angle(year: int, month: int, day: int) -> float:
    """Lunar node angle N in radians."""
    a = math.floor((14 - month) / 12)
    y = year + 4800 - a
    m = month + 12 * a - 3
    jd = day + math.floor((153 * m + 2) / 5) + 365 * y + \
         math.floor(y / 4) - math.floor(y / 100) + math.floor(y / 400) - 32045
    T = (jd - 2451545.0) / 36525.0
    return math.radians(125.04 - 1934.136 * T)


def _nodal_corrections(name: str, N: float) -> tuple[float, float]:
    """Return (f, u_radians) nodal correction factors."""
    lunar = {'M2', 'N2', '2N2', 'MU2', 'NU2', 'LDA2', 'EPS2', 'L2',
             'M3', 'M4', 'MN4', 'MS4', 'M6', 'M8', '2MS6', 'MK3', 'SN4'}
    if name in lunar:
        return 1.0 - 0.037 * math.cos(N), math.radians(-2.14 * math.sin(N))
    if name in ('O1', 'Q1', '2Q1', 'RHO1'):
        return 1.0 + 0.189 * math.cos(N), math.radians(10.8 * math.sin(N))
    if name in ('K1', 'J1', 'M1'):
        return 1.0 + 0.115 * math.cos(N), math.radians(-8.9 * math.sin(N))
    if name == 'OO1':
        return 1.0 + 0.640 * math.cos(N), 0.0
    if name in ('MF', 'MM', 'MSF'):
        return 1.0 - 0.130 * math.cos(N), 0.0
    return 1.0, 0.0


def analyze(times: list[datetime], values: list[float],
            max_constituents: int = 37) -> dict:
    """
    Harmonic analysis via iteratively reweighted least-squares (IRLS).

    The IRLS approach fits tidal constituents and then downweights outlier
    residuals (> 2σ) before refitting, making the analysis robust against
    spike data that may slip through quality filters.

    Returns dict with:
      mean, constituents: {name: {freq, amp, phase, a, b, f, u}}, r2, rmse,
      nodal_N (for prediction consistency)
    """
    n = len(times)
    if n < 48:
        raise ValueError("Need at least 48 data points")

    vals = np.array(values, dtype=np.float64)
    mean = float(np.mean(vals))
    y = vals - mean

    # Reference time
    t0 = times[0]
    # Hours since t0
    t_hours = np.array([(t - t0).total_seconds() / 3600.0 for t in times], dtype=np.float64)

    # Select constituents — Rayleigh criterion:
    # 1. Period must be < data span (at least 1 full cycle)
    # 2. Frequency separation between any two must be > 1/span (resolvable)
    span_hours = t_hours[-1] - t_hours[0]
    rayleigh = 360.0 / span_hours  # minimum frequency separation in °/hr

    candidates = []
    for k, freq in CONSTITUENTS.items():
        if freq > 0 and (360.0 / freq) < span_hours:
            candidates.append((k, freq))

    # Sort by typical tidal importance (semidiurnal > diurnal > others)
    importance = ['M2','S2','N2','K1','O1','P1','K2','Q1','M4','MS4','MN4',
                  'M6','L2','2N2','MU2','NU2','J1','OO1','M3','MK3','SK3',
                  'MF','MM','2Q1','RHO1','M1','S1','LDA2','EPS2','T2',
                  'M8','2MS6','SN4','MSF','SSA','SA']
    candidates.sort(key=lambda x: importance.index(x[0]) if x[0] in importance else 99)

    names = []
    selected_freqs = []
    for k, freq in candidates:
        if len(names) >= max_constituents:
            break
        # Check this frequency is resolvable against all already-selected
        too_close = any(abs(freq - sf) < rayleigh for sf in selected_freqs)
        if not too_close:
            names.append(k)
            selected_freqs.append(freq)

    M = len(names)
    if M < 4:
        raise ValueError(f"Only {M} resolvable constituents for {span_hours:.0f}h span")

    # Nodal corrections at midpoint of series
    mid = times[n // 2]
    N = _node_angle(mid.year, mid.month, mid.day)

    # Build design matrix A: n × (2M)
    # Each constituent j contributes: f_j * cos(ω_j*t + u_j), f_j * sin(ω_j*t + u_j)
    A = np.zeros((n, 2 * M), dtype=np.float64)
    omegas = []
    fs = []
    us = []

    for j, name in enumerate(names):
        freq_deg_hr = CONSTITUENTS[name]
        omega = math.radians(freq_deg_hr)  # rad/hour
        f, u = _nodal_corrections(name, N)
        omegas.append(omega)
        fs.append(f)
        us.append(u)
        phase = omega * t_hours + u
        A[:, 2 * j] = f * np.cos(phase)
        A[:, 2 * j + 1] = f * np.sin(phase)

    # ── IRLS: Iteratively Reweighted Least Squares ──
    # Start with uniform weights, then downweight outliers
    weights = np.ones(n, dtype=np.float64)

    for iteration in range(3):
        # Weighted design matrix
        W_sqrt = np.sqrt(weights)
        Aw = A * W_sqrt[:, np.newaxis]
        yw = y * W_sqrt

        # Solve normal equations: (Aw^T Aw) x = Aw^T yw
        ATA = Aw.T @ Aw
        ATy = Aw.T @ yw

        # Regularize slightly for numerical stability
        ATA += np.eye(2 * M) * 1e-10

        try:
            x = np.linalg.solve(ATA, ATy)
        except np.linalg.LinAlgError:
            x = np.linalg.lstsq(A * W_sqrt[:, np.newaxis], yw, rcond=None)[0]

        # Compute residuals and update weights
        residuals = y - A @ x
        sigma = np.std(residuals[weights > 0.5]) if np.sum(weights > 0.5) > 10 else np.std(residuals)

        if sigma < 1e-10 or iteration == 2:
            break  # converged or last iteration

        # Tukey bisquare-style: zero weight for > 3σ, reduced for > 2σ
        abs_res = np.abs(residuals)
        weights = np.ones(n, dtype=np.float64)
        mask_suspect = abs_res > 2.0 * sigma
        mask_outlier = abs_res > 3.0 * sigma
        weights[mask_suspect] = np.maximum(0.0, 1.0 - ((abs_res[mask_suspect] - 2.0 * sigma) / sigma) ** 2)
        weights[mask_outlier] = 0.0

        n_down = int(np.sum(mask_suspect))
        n_out = int(np.sum(mask_outlier))
        if n_down > 0:
            logger.info("IRLS iter %d: downweighted %d points (%d zeroed), σ=%.4f",
                        iteration + 1, n_down, n_out, sigma)

    # Extract amplitudes and phases
    constituents = {}
    for j, name in enumerate(names):
        a, b = float(x[2 * j]), float(x[2 * j + 1])
        amp = math.sqrt(a * a + b * b)
        phase_deg = math.degrees(math.atan2(b, a))
        if phase_deg < 0:
            phase_deg += 360
        constituents[name] = {
            'freq': CONSTITUENTS[name],
            'amp': round(amp, 6),
            'phase': round(phase_deg, 2),
            'a': round(a, 6),
            'b': round(b, 6),
            'f': round(fs[j], 6),
            'u': round(math.degrees(us[j]), 4),
        }

    # Compute fit quality (using only well-weighted points)
    predicted = A @ x + mean
    good = weights > 0.5
    residuals_good = vals[good] - predicted[good]
    ss_res = float(np.sum(residuals_good ** 2))
    ss_tot = float(np.sum((vals[good] - np.mean(vals[good])) ** 2))
    r2 = 1.0 - ss_res / ss_tot if ss_tot > 0 else 0.0
    rmse = float(np.sqrt(ss_res / max(np.sum(good), 1)))

    n_outliers = int(np.sum(~good))

    return {
        'mean': round(mean, 6),
        'constituents': constituents,
        'r2': round(r2, 6),
        'rmse': round(rmse, 6),
        'n_points': n,
        'n_outliers': n_outliers,
        'n_constituents': M,
        't0': t0.isoformat(),
        'nodal_N': N,  # store for prediction consistency
    }


def predict(analysis: dict, start: datetime, end: datetime,
            interval_min: int = 10) -> list[dict]:
    """
    Generate tide predictions from analysis results.

    Uses the same nodal corrections as the analysis for consistency.
    Returns list of {ts: ISO string, level: float}.
    """
    mean = analysis['mean']
    constituents = analysis['constituents']
    t0 = datetime.fromisoformat(analysis['t0'])

    # Use analysis-period nodal angle for consistency
    N = analysis.get('nodal_N')
    if N is None:
        # Fallback: recompute at prediction midpoint
        mid = start + (end - start) / 2
        N = _node_angle(mid.year, mid.month, mid.day)

    results = []
    t = start
    delta = timedelta(minutes=interval_min)

    while t <= end:
        hours = (t - t0).total_seconds() / 3600.0
        level = mean
        for name, c in constituents.items():
            omega = math.radians(c['freq'])
            f, u = _nodal_corrections(name, N)
            level += f * (c['a'] * math.cos(omega * hours + u) +
                          c['b'] * math.sin(omega * hours + u))
        results.append({'ts': t.isoformat(), 'level': round(level, 4)})
        t += delta

    return results
