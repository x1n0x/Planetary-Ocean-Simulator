"""GET /scenarios — list every precomputed scenario with its metadata."""
from fastapi import APIRouter

from services import zarr_reader

router = APIRouter()


@router.get("/scenarios")
def list_scenarios():
    out = []
    for name in zarr_reader.scenario_ids():
        meta = zarr_reader.load_metadata(name)
        out.append({"id": name, **meta})
    return out
