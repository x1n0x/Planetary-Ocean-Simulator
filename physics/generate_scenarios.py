# Disable threading BEFORE importing numpy/dedalus.
import os
os.environ.setdefault("OMP_NUM_THREADS", "1")

import logging

from tidal_swe import (
    run_tidal_swe, write_zarr, equilibrium_tide_amplitude, EARTH_OMEGA,
)

logger = logging.getLogger(__name__)

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")

STEPS = 200
DT = 600.0
EVENT_STEP = 90        # inject the tsunami partway through
NOISE = 0.03           # observational η-noise floor for the anomaly detector


def single_name(omega_rel, moon_dist_km, temp_c):
    omega_str = f"{omega_rel:g}".replace(".", "p")
    return (f"scenario_moon{int(moon_dist_km / 1000)}km"
            f"_omega{omega_str}x_temp{int(temp_c)}")


# 20+ precomputed scenarios covering the full slider range (CLAUDE.md §7.6) ---
# Ω: 0.1–5× Earth · moon distance: 192k–1152k km (0.5×–3× Earth–Moon) · temp.
OMEGAS = [0.1, 1.0, 3.0, 5.0]
DISTS = [192000, 384000, 768000, 1152000]
SINGLE = [(o, d, 15) for o in OMEGAS for d in DISTS]      # 16: full Ω×distance grid
SINGLE += [(1.0, 384000, 5), (1.0, 384000, 28)]           # +2 temperature variants

# Multi-moon scenarios — superposed tidal potentials (Phase 4 [K]).
#   (suffix, moons[list], omega_rel, temp, repr_dist_km, repr_mass)
MULTI = [
    ("2moon", [{"dist_km": 384000, "mass_rel": 1.0, "lat0_deg": 0, "lon0_deg": 0},
               {"dist_km": 384000, "mass_rel": 0.8, "lat0_deg": 30, "lon0_deg": 110}],
     1.0, 15, 384000, 1.8),
    ("2moonclose", [{"dist_km": 384000, "mass_rel": 1.0, "lat0_deg": 0, "lon0_deg": 0},
                    {"dist_km": 260000, "mass_rel": 0.5, "lat0_deg": -20, "lon0_deg": 180}],
     1.0, 15, 384000, 1.5),
    ("3moon", [{"dist_km": 384000, "mass_rel": 1.0, "lat0_deg": 0, "lon0_deg": 0},
               {"dist_km": 500000, "mass_rel": 1.2, "lat0_deg": 25, "lon0_deg": 120},
               {"dist_km": 320000, "mass_rel": 0.7, "lat0_deg": -35, "lon0_deg": -120}],
     2.0, 15, 384000, 2.9),
]


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    os.makedirs(DATA_DIR, exist_ok=True)
    names = []

    for omega_rel, moon_km, temp_c in SINGLE:
        name = single_name(omega_rel, moon_km, temp_c)
        eta, u, v, chi, E_k, E_p, pk = run_tidal_swe(
            Nphi=128, Ntheta=64, T=STEPS, timestep_s=DT, omega_rel=omega_rel,
            moon_dist_km=moon_km, with_topography=True,
            event_step=EVENT_STEP, noise_floor_m=NOISE,
        )
        write_zarr(os.path.join(DATA_DIR, name), eta, u, v, chi, E_k, E_p,
                   timestep_s=DT, T=STEPS, omega_rel=omega_rel,
                   moon_dist_km=moon_km, moon_mass_rel=1.0, temp_c=temp_c)
        logger.info("%-40s Ω=%.1f× d=%dk peak|η|=%.2fm", name, omega_rel,
                    int(moon_km / 1000), pk)
        names.append(name)

    for suffix, moons, omega_rel, temp_c, rdist, rmass in MULTI:
        name = f"scenario_{suffix}_omega{f'{omega_rel:g}'.replace('.', 'p')}x_temp{int(temp_c)}"
        eta, u, v, chi, E_k, E_p, pk = run_tidal_swe(
            Nphi=128, Ntheta=64, T=STEPS, timestep_s=DT, omega_rel=omega_rel,
            moons=moons, with_topography=True,
            event_step=EVENT_STEP, noise_floor_m=NOISE,
        )
        write_zarr(os.path.join(DATA_DIR, name), eta, u, v, chi, E_k, E_p,
                   timestep_s=DT, T=STEPS, omega_rel=omega_rel,
                   moon_dist_km=rdist, moon_mass_rel=rmass, temp_c=temp_c)
        logger.info("%-40s %d moons peak|η|=%.2fm", name, len(moons), pk)
        names.append(name)

    print(f"\nWrote {len(names)} real scenarios to {DATA_DIR}")
    return names


if __name__ == "__main__":
    main()
