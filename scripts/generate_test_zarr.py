"""Generate fake scenario zarr stores for frontend/backend development.

Extends CLAUDE.md §13: instead of one flat tidal wave this builds a small
library with an island (chi != 0), a rotation-dependent flow, and an injected
"event" (a localized rogue bump + velocity burst) so the Phase 3 anomaly
detectors and the energy-spike chart have something real to fire on.

Everything still follows the zarr schema in §4 — when Kirill's real stores
arrive they drop straight in. Run from anywhere:
    python scripts/generate_test_zarr.py
"""
import os
import json
import shutil

import numpy as np
import zarr

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(REPO_ROOT, "backend", "data")

T, LAT, LON = 120, 64, 128
RHO, G, H0 = 1025.0, 9.81, 4000.0
EARTH_OMEGA = 7.292e-5

# geographic axes (degrees) and radian grids
lat_deg = np.linspace(-90, 90, LAT)
lon_deg = np.linspace(-180, 180, LON)
lat_rad = np.deg2rad(lat_deg)
lon_rad = np.deg2rad(lon_deg)
LONr, LATr = np.meshgrid(lon_rad, lat_rad)  # (LAT, LON)
II, JJ = np.meshgrid(np.arange(LAT), np.arange(LON), indexing="ij")


def make_island() -> np.ndarray:
    """Smooth tanh land blob (§3.4): chi -> 1 on land, 0 over ocean."""
    lat0, lon0 = np.deg2rad(20), np.deg2rad(40)
    # rough great-circle-ish distance, longitude scaled by cos(lat)
    d = np.sqrt((LATr - lat0) ** 2 + ((LONr - lon0) * np.cos(LATr)) ** 2)
    radius, edge = np.deg2rad(18), np.deg2rad(4)
    chi = 0.5 * (1 + np.tanh((radius - d) / edge))
    return chi.astype("float32")


CHI = make_island()
WET = CHI < 0.5

# event location: a wet mid-latitude cell well away from the island
EV_I = int(np.argmin(np.abs(lat_deg - (-30))))
EV_J = int(np.argmin(np.abs(lon_deg - (-100))))
EV_T0, EV_T1 = 70, 73  # event lives on [70, 72]; detection is sharpest at onset
NOISE_STD = 0.05  # observational noise floor (m) — keeps z bounded in calm cells
# Tide drifts slowly: within a 20-step detector window the change is below the
# noise floor (so the z-score stays calm), yet it still sweeps over a full run.
TIDE_FREQ = 0.05


def inject_event(eta, u, v):
    """A localized rogue bump + velocity burst → threshold + energy anomaly."""
    sigma = 2.0
    gauss = np.exp(-(((II - EV_I) ** 2 + (JJ - EV_J) ** 2) / (2 * sigma**2)))
    for i in range(EV_T0, EV_T1):
        eta[i] += 2.5 * gauss
        u[i] += 3.0 * gauss
        v[i] += 2.0 * gauss


def build_scenario(omega_rel, moon_dist_km, temp_c):
    rng = np.random.default_rng(42)
    t_axis = np.linspace(0, 2 * np.pi, T)
    # tide amplitude ∝ d^-3, anchored to η0 ≈ 0.36 m at the Earth–Moon distance
    amp = 0.36 * (384_000 / moon_dist_km) ** 3

    eta = np.zeros((T, LAT, LON), dtype="float32")
    u = np.zeros_like(eta)
    v = np.zeros_like(eta)
    for i, tt in enumerate(t_axis):
        ph = TIDE_FREQ * tt
        tide = amp * np.cos(ph + LONr) * np.cos(LATr)
        jets = 0.15 * omega_rel * np.sin(3 * LATr) * np.cos(0.15 * tt)
        eta[i] = tide + jets
        u[i] = -1.0 * amp * np.sin(ph + LONr) + 0.3 * omega_rel * np.cos(2 * LATr)
        v[i] = 0.5 * amp * np.cos(ph + LONr)

    # observational noise floor so quiet cells don't trip the z-score detector
    eta += rng.normal(0, NOISE_STD, eta.shape).astype("float32")
    inject_event(eta, u, v)

    # zero everything on land
    eta[:, ~WET] = 0.0
    u[:, ~WET] = 0.0
    v[:, ~WET] = 0.0

    # energies over the wet area only (§3.5)
    E_k = np.array(
        [0.5 * RHO * H0 * np.sum((u[i] ** 2 + v[i] ** 2) * WET) for i in range(T)],
        dtype="float32",
    )
    E_p = np.array(
        [0.5 * RHO * G * np.sum((eta[i] ** 2) * WET) for i in range(T)],
        dtype="float32",
    )
    return eta, u, v, E_k, E_p


def write_scenario(omega_rel, moon_dist_km, temp_c):
    omega_str = f"{omega_rel:g}".replace(".", "p")
    name = (
        f"scenario_moon{int(moon_dist_km / 1000)}km"
        f"_omega{omega_str}x_temp{int(temp_c)}"
    )
    scenario_dir = os.path.join(DATA_DIR, name)
    if os.path.isdir(scenario_dir):
        shutil.rmtree(scenario_dir)
    os.makedirs(scenario_dir)

    eta, u, v, E_k, E_p = build_scenario(omega_rel, moon_dist_km, temp_c)
    store = zarr.open(scenario_dir, mode="w")
    # all 3D arrays chunked (1, lat, lon) for O(1) single-timestep reads (§4.3)
    store.create_dataset("eta", data=eta, chunks=(1, LAT, LON))
    store.create_dataset("u", data=u, chunks=(1, LAT, LON))
    store.create_dataset("v", data=v, chunks=(1, LAT, LON))
    store.create_dataset("chi", data=CHI)
    store.create_dataset("E_k", data=E_k)
    store.create_dataset("E_p", data=E_p)

    json.dump(
        {
            "moon_dist_km": moon_dist_km,
            "moon_mass_rel": 1.0,
            "omega_rad_s": omega_rel * EARTH_OMEGA,
            "temperature_C": temp_c,
            "grid_shape": [LAT, LON],
            "dt_seconds": 1800,
            "T_total_steps": T,
            "lat_range": [-90, 90],
            "lon_range": [-180, 180],
        },
        open(os.path.join(scenario_dir, "metadata.json"), "w"),
    )
    return name


# small library: vary Ω, plus a closer moon and a warm variant
LIBRARY = [
    (0.1, 384_000, 15),
    (1.0, 384_000, 15),
    (3.0, 384_000, 15),
    (5.0, 384_000, 15),
    (1.0, 192_000, 15),
    (1.0, 384_000, 28),
]

if __name__ == "__main__":
    os.makedirs(DATA_DIR, exist_ok=True)
    # drop the old single-wave test scenario if present
    old = os.path.join(DATA_DIR, "scenario_test_moon384km_omega1x_temp15")
    if os.path.isdir(old):
        shutil.rmtree(old)

    names = [write_scenario(*cfg) for cfg in LIBRARY]
    print(f"Wrote {len(names)} scenarios to {DATA_DIR}:")
    for n in names:
        print(f"  {n}")
    print(
        f"Island chi: {int(np.sum(WET))} ocean / {int(np.sum(~WET))} land cells. "
        f"Event at t={EV_T0}-{EV_T1 - 1}, cell (lat={lat_deg[EV_I]:.0f}, "
        f"lon={lon_deg[EV_J]:.0f})."
    )
