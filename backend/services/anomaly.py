"""Anomaly detection — three independent layers (CLAUDE.md §6).

Always apply the wet mask (chi < 0.5) before flagging so land cells are never
reported as anomalies. Layers 1 (threshold) and 3 (energy spike) run now;
layer 2 (isolation forest) is used only when a trained model is present.
"""
import numpy as np


def detect_threshold(eta_window, k: float = 3.0, wet_mask=None):
    """Layer 1 — z-score of the latest frame vs the preceding window (§6.1)."""
    mean = eta_window[:-1].mean(axis=0)
    std = eta_window[:-1].std(axis=0) + 1e-8
    current = eta_window[-1]
    z = (current - mean) / std
    anomaly = np.abs(z) > k
    if wet_mask is not None:
        anomaly = anomaly & wet_mask
        z = z.copy()
        z[~wet_mask] = 0.0
    return anomaly, z


def detect_isolation(clf, eta_t, u_t, v_t, wet_mask):
    """Layer 2 — Isolation Forest over [eta, u, v, speed] per wet cell (§6.2).

    More negative score = more anomalous. Threshold: < -0.15.
    """
    lat, lon = eta_t.shape
    speed = np.sqrt(u_t**2 + v_t**2)
    X = np.stack([eta_t, u_t, v_t, speed], axis=-1).reshape(-1, 4)
    scores = np.zeros(lat * lon)
    wet_idx = wet_mask.ravel()
    scores[wet_idx] = clf.decision_function(X[wet_idx])
    return scores.reshape(lat, lon)


def detect_energy_spike(E_k_series, window: int = 10, alpha: float = 3.0) -> dict:
    """Layer 3 — sudden jump in kinetic energy vs recent baseline (§6.3)."""
    E = np.asarray(E_k_series, dtype=float)
    if len(E) < window + 2:
        return {"spike": False, "severity": 0.0}
    deltas = np.abs(np.diff(E))
    current = deltas[-1]
    baseline_mean = deltas[-window - 1 : -1].mean() + 1e-12
    severity = current / baseline_mean
    return {
        "spike": bool(severity > alpha),
        "severity": float(severity),
        "delta": float(current),
        "baseline": float(baseline_mean),
    }
