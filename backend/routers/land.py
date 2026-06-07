"""GET /land — static land mask chi (lat, lon).

Call once per scenario and cache client-side (CLAUDE.md §5.3). chi is
time-independent, served straight from the startup cache.
"""
from fastapi import APIRouter, HTTPException

from services import zarr_reader

router = APIRouter()


@router.get("/land")
def get_land(scenario: str):
    try:
        chi = zarr_reader.get_land(scenario)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Unknown scenario: {scenario}")
    return {"chi": chi.tolist()}
