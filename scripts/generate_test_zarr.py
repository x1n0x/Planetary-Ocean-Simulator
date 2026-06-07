"""Generate a fake scenario zarr for frontend/backend development.

Mirrors CLAUDE.md §13. Lets Vlad build the globe + API while waiting for
Kirill's real Dedalus output. Writes a single tidal-wave scenario into
backend/data/ following the zarr schema in §4.

Run from anywhere:
    python scripts/generate_test_zarr.py
"""
import os
import json

import numpy as np
import zarr

# Anchor paths to the repo root (parent of scripts/), not the cwd.
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(REPO_ROOT, "backend", "data")

T, lat, lon = 100, 64, 128
name = "scenario_test_moon384km_omega1x_temp15"
scenario_dir = os.path.join(DATA_DIR, name)
os.makedirs(scenario_dir, exist_ok=True)

store = zarr.open(scenario_dir, mode="w")

# Fake tidal wave
t_axis = np.linspace(0, 2 * np.pi, T)
lat_ax = np.linspace(-np.pi / 2, np.pi / 2, lat)
lon_ax = np.linspace(-np.pi, np.pi, lon)
LON, LAT = np.meshgrid(lon_ax, lat_ax)

eta = np.array([0.3 * np.cos(t + LON) * np.cos(LAT) for t in t_axis], dtype="float32")
u = np.array([-0.1 * np.sin(t + LON) for t in t_axis], dtype="float32")
v = np.zeros_like(u)
chi = np.zeros((lat, lon), dtype="float32")
E_k = np.array(
    [float(np.sum(0.5 * 1025 * 4000 * (u[i] ** 2 + v[i] ** 2))) for i in range(T)],
    dtype="float32",
)
E_p = np.array(
    [float(np.sum(0.5 * 1025 * 9.81 * eta[i] ** 2)) for i in range(T)],
    dtype="float32",
)

# All 3D arrays chunked (1, lat, lon) — O(1) single-timestep reads (§4.3).
store.create_dataset("eta", data=eta, chunks=(1, lat, lon))
store.create_dataset("u", data=u, chunks=(1, lat, lon))
store.create_dataset("v", data=v, chunks=(1, lat, lon))
store.create_dataset("chi", data=chi)
store.create_dataset("E_k", data=E_k)
store.create_dataset("E_p", data=E_p)

json.dump(
    {
        "moon_dist_km": 384000,
        "moon_mass_rel": 1.0,
        "omega_rad_s": 7.292e-5,
        "temperature_C": 15.0,
        "grid_shape": [lat, lon],
        "dt_seconds": 1800,
        "T_total_steps": T,
        "lat_range": [-90, 90],
        "lon_range": [-180, 180],
    },
    open(os.path.join(scenario_dir, "metadata.json"), "w"),
)
print(f"Test scenario written to {scenario_dir}")
