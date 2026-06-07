"""GET /state — eta, u, v and energies at a single timestep.

Target < 50 ms (CLAUDE.md §8): zarr is chunked (1, lat, lon) so reading a
single timestep touches exactly one chunk.
"""
from fastapi import APIRouter, HTTPException

from services import zarr_reader

router = APIRouter()


@router.get("/state")
def get_state(scenario: str, t: int):
    try:
        s = zarr_reader.get_store(scenario)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Unknown scenario: {scenario}")

    T = s["eta"].shape[0]
    if not 0 <= t < T:
        raise HTTPException(
            status_code=400, detail=f"t={t} out of range [0, {T})"
        )

    return {
        "scenario": scenario,
        "t": t,
        "eta": s["eta"][t].tolist(),
        "u": s["u"][t].tolist(),
        "v": s["v"][t].tolist(),
        "E_k": float(s["E_k"][t]),
        "E_p": float(s["E_p"][t]),
    }
