"""GET /anomaly — composite of the three detection layers (CLAUDE.md §5.4, §6).

Threshold (L1) and energy spike (L3) always run; the isolation forest (L2) is
folded into the composite only when a trained model exists for the scenario.
"""
import numpy as np
from fastapi import APIRouter, HTTPException

from services import zarr_reader
from services.anomaly import (
    detect_threshold,
    detect_isolation,
    detect_energy_spike,
)

router = APIRouter()


@router.get("/anomaly")
def get_anomaly(scenario: str, t: int, window: int = 20):
    try:
        s = zarr_reader.get_store(scenario)
        chi = zarr_reader.get_land(scenario)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Unknown scenario: {scenario}")

    T = s["eta"].shape[0]
    if not 0 <= t < T:
        raise HTTPException(status_code=400, detail=f"t={t} out of range [0, {T})")

    wet = chi < 0.5
    t_start = max(0, t - window)
    eta_win = np.array(s["eta"][t_start : t + 1])
    u_t = np.array(s["u"][t])
    v_t = np.array(s["v"][t])
    E_k_hist = list(s["E_k"][: t + 1])

    # need at least a couple of history frames for a meaningful z-score
    if eta_win.shape[0] >= 3:
        th_mask, z = detect_threshold(eta_win, k=3.0, wet_mask=wet)
    else:
        th_mask = np.zeros_like(wet)
        z = np.zeros(wet.shape, dtype=float)

    clf = zarr_reader.get_model(scenario.split("_")[0])
    iso = (
        detect_isolation(clf, eta_win[-1], u_t, v_t, wet)
        if clf is not None
        else None
    )

    energy = detect_energy_spike(E_k_hist)
    composite = th_mask
    if iso is not None:
        composite = composite | (iso < -0.15)

    return {
        "threshold_mask": th_mask.tolist(),
        "z_scores": z.tolist(),
        "isolation_scores": iso.tolist() if iso is not None else [],
        "composite_mask": composite.tolist(),
        "energy_spike": energy,
        "anomaly_count": int(np.asarray(composite).sum()),
    }
