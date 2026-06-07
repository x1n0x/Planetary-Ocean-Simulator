"""Startup-cached access to zarr stores, land masks and sklearn models.

CLAUDE.md §5.2: every zarr store, land mask and model is opened ONCE at
startup. Never re-open zarr or re-load joblib on a per-request basis.
The caches live here (not in main.py) so routers share the same objects.
"""
import os
import json

import numpy as np
import zarr

# data/ and models/ sit next to main.py, i.e. one level up from services/.
BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BACKEND_DIR, "data")
MODELS_DIR = os.path.join(BACKEND_DIR, "models")

# scenario_id -> zarr.Group
_store_cache: dict = {}
# scenario_id -> np.ndarray (lat, lon)
_land_cache: dict = {}
# model_key -> IsolationForest
_iso_forest_cache: dict = {}


def preload() -> None:
    """Populate all caches. Called once from FastAPI startup."""
    if os.path.isdir(DATA_DIR):
        for name in os.listdir(DATA_DIR):
            scenario_dir = os.path.join(DATA_DIR, name)
            if not os.path.isdir(scenario_dir):
                continue
            store = zarr.open(scenario_dir, mode="r")
            _store_cache[name] = store
            _land_cache[name] = np.array(store["chi"])

    if os.path.isdir(MODELS_DIR):
        import joblib

        for f in os.listdir(MODELS_DIR):
            if f.endswith(".joblib"):
                _iso_forest_cache[f[:-7]] = joblib.load(os.path.join(MODELS_DIR, f))

    print(
        f"[zarr_reader] Loaded {len(_store_cache)} scenarios, "
        f"{len(_iso_forest_cache)} models from {DATA_DIR}"
    )


def scenario_ids() -> list:
    return list(_store_cache.keys())


def get_store(scenario: str):
    return _store_cache[scenario]


def get_land(scenario: str) -> np.ndarray:
    return _land_cache[scenario]


def get_model(model_key: str):
    return _iso_forest_cache.get(model_key)


def load_metadata(scenario: str) -> dict:
    with open(os.path.join(DATA_DIR, scenario, "metadata.json")) as fh:
        return json.load(fh)
