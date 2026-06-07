"""GET /energy — full E_k / E_p time series + detected spike timesteps.

Feeds the Plotly EnergyChart (CLAUDE.md §7.8). Spikes are the timesteps where
the Layer-3 energy detector (§6.3) fires on the kinetic-energy series.
"""
import numpy as np
from fastapi import APIRouter, HTTPException

from services import zarr_reader
from services.anomaly import detect_energy_spike

router = APIRouter()


@router.get("/energy")
def get_energy(scenario: str):
    try:
        s = zarr_reader.get_store(scenario)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Unknown scenario: {scenario}")

    E_k = np.array(s["E_k"], dtype=float)
    E_p = np.array(s["E_p"], dtype=float)
    spikes = [
        i
        for i in range(len(E_k))
        if detect_energy_spike(list(E_k[: i + 1]))["spike"]
    ]
    return {"E_k": E_k.tolist(), "E_p": E_p.tolist(), "spikes": spikes}
