# Disable threading BEFORE importing numpy/dedalus.
import os
os.environ.setdefault("OMP_NUM_THREADS", "1")

import json
import shutil
import argparse
import logging

import numpy as np
import dedalus.public as d3

logger = logging.getLogger(__name__)

# physical constants
G_SI = 9.81             # gravity, m/s^2
H0_SI = 4000.0          # mean ocean depth, m
RHO = 1025.0            # seawater density, kg/m^3
R_SI = 6.371e6          # planet radius, m
EARTH_OMEGA = 7.292e-5  # Earth rotation rate, rad/s

# Unit scaling for spectral conditioning (as in Dedalus' sphere SWE example):
# nondimensionalise length by the radius and time by the hour so the operator
# matrices stay well-conditioned. Outputs are converted back to SI before write.
METER = 1.0 / R_SI
HOUR = 1.0
SECOND = HOUR / 3600.0

# nondim conversions back to SI: multiply a nondim value by these.
LEN_TO_SI = 1.0 / METER              # nondim length  -> metres  (= R_SI)
VEL_TO_SI = SECOND / METER           # nondim speed   -> m/s     (= R_SI/3600)


def run_sphere_swe(
    Nphi: int = 128,        # longitude points -> output axis 1 (lon)
    Ntheta: int = 64,       # colatitude points -> output axis 0 (lat)
    T: int = 150,           # stored timesteps (>100 to satisfy Phase 1)
    timestep_s: float = 600.0,   # dt, seconds
    omega_rel: float = 1.0,      # rotation rate relative to Earth
    u0_ms: float = 20.0,         # solid-body zonal speed at equator, m/s
):
    """Rotating Shallow Water on the FULL SPHERE — Phase 1 [K].

    Uses `d3.SphereBasis` (NOT S2Basis — CLAUDE.md §3.6) with full-sphere
    Coriolis f(φ) = 2Ω·sin(φ), implemented via the Dedalus idiom

        zcross(u) = MulCosine(skew(u))

    MulCosine multiplies by cos(colatitude) = sin(latitude), so 2Ω·zcross(u)
    is exactly f·k̂×u with f = 2Ω·sin(φ).

        dt(u) + g·grad(η) + 2Ω·zcross(u) + hyperdiff = -(u·grad)u
        dt(η) + H₀·div(u)                + hyperdiff = -div(η·u)

    Initial condition: Williamson et al. (1992) Test Case 2 — solid-body
    rotation in exact geostrophic balance. With Coriolis correct this is a
    STEADY state, so a small drift over 100+ steps validates both stability
    and the Coriolis term.

    Returns geographic-order arrays (T, Ntheta, Nphi) = (T, lat, lon) in SI,
    lat south→north, lon west→east (CLAUDE.md §4.4), plus E_k, E_p (T,).
    """
    dtype = np.float64
    coords = d3.S2Coordinates("phi", "theta")  # phi=longitude, theta=colatitude
    dist = d3.Distributor(coords, dtype=dtype)
    basis = d3.SphereBasis(
        coords, (Nphi, Ntheta), radius=R_SI * METER, dealias=3 / 2, dtype=dtype
    )

    u = dist.VectorField(coords, name="u", bases=basis)
    h = dist.Field(name="h", bases=basis)  # surface elevation anomaly η

    # nondim parameters
    g = G_SI * METER / SECOND**2
    H0 = H0_SI * METER
    Omega = (omega_rel * EARTH_OMEGA) / SECOND
    radius = R_SI * METER
    u0 = u0_ms * METER / SECOND

    # 4th-order hyperdiffusion, tuned to e-fold the grid scale (ℓ≈Ntheta) over
    # ~10 steps. lap eigenvalue on the unit sphere is -ℓ(ℓ+1).
    timestep = timestep_s * SECOND
    ell_max = Ntheta
    lap_eig = (ell_max * (ell_max + 1)) ** 2  # [ℓ(ℓ+1)]^2 for lap(lap)
    nu4 = 1.0 / (10.0 * timestep * lap_eig)

    # full-sphere Coriolis idiom (CLAUDE.md §3.2)
    zcross = lambda A: d3.MulCosine(d3.skew(A))
    lap = lambda A: d3.lap(A)
    grad = lambda A: d3.grad(A)
    div = lambda A: d3.div(A)

    namespace = {**locals(), "g": g, "H0": H0, "Omega": Omega, "nu4": nu4}
    problem = d3.IVP([u, h], namespace=namespace)
    problem.add_equation(
        "dt(u) + g*grad(h) + 2*Omega*zcross(u) + nu4*lap(lap(u)) = - u@grad(u)"
    )
    problem.add_equation("dt(h) + H0*div(u) + nu4*lap(lap(h)) = - div(h*u)")

    solver = problem.build_solver(d3.RK443)

    # Williamson TC2 IC
    phi, theta = dist.local_grids(basis)  # theta = colatitude
    # zonal solid-body flow u_phi = u0·sin(theta) (= u0·cos(lat)); u_theta = 0
    u.change_scales(1)
    u["g"][0] = u0 * np.sin(theta)
    u["g"][1] = 0.0
    # geostrophic-balance height, written as a zero-mean anomaly:
    #   h = -(C/g)·(cos²θ - 1/3),  C = radius·Ω·u0 + u0²/2
    C = radius * Omega * u0 + 0.5 * u0**2
    h.change_scales(1)
    h["g"] = -(C / g) * (np.cos(theta) ** 2 - 1.0 / 3.0)

    # area weights for energy diagnostics (∝ sinθ); nominal dA factor
    dtheta, dphi = np.pi / Ntheta, 2 * np.pi / Nphi
    area = (R_SI**2) * np.sin(theta) * dtheta * dphi  # (1, Ntheta), SI m^2

    eta_out = np.empty((T, Ntheta, Nphi), dtype="float32")
    u_out = np.empty((T, Ntheta, Nphi), dtype="float32")
    v_out = np.empty((T, Ntheta, Nphi), dtype="float32")
    E_k = np.empty(T, dtype="float32")
    E_p = np.empty(T, dtype="float32")

    def to_geo(a2d):
        # (Nphi, Ntheta) -> (Ntheta, Nphi) = (lat, lon). Dedalus theta is
        # DESCENDING (rows already south-first); phi starts at 0 while the
        # schema puts lon -180 at col 0 -> roll half a revolution.
        return np.roll(a2d.T, -(Nphi // 2), axis=1).copy()

    for n in range(T):
        h.change_scales(1)
        u.change_scales(1)
        eta_si = h["g"] * LEN_TO_SI          # (Nphi, Ntheta)
        u_si = u["g"][0] * VEL_TO_SI         # zonal (eastward)
        # e_theta points south (colatitude increases southward) -> v_north = -u_theta
        v_si = -u["g"][1] * VEL_TO_SI

        eta_out[n] = to_geo(eta_si)
        u_out[n] = to_geo(u_si)
        v_out[n] = to_geo(v_si)

        # energy in (Nphi,Ntheta) space with sinθ area weight
        E_k[n] = 0.5 * RHO * H0_SI * np.sum((u_si**2 + v_si**2) * area)
        E_p[n] = 0.5 * RHO * G_SI * np.sum((eta_si**2) * area)

        if n % 25 == 0:
            logger.info(
                "step %3d/%d  max|u|=%.2f m/s  max|eta|=%.2f m  E_tot=%.3e J",
                n, T, np.abs(u_si).max(), np.abs(eta_si).max(),
                E_k[n] + E_p[n],
            )
        if n < T - 1:
            solver.step(timestep)

    return eta_out, u_out, v_out, E_k, E_p


def write_zarr(out_dir, eta, u, v, E_k, E_p, timestep_s, T, omega_rel):
    import zarr

    Ny, Nx = eta.shape[1], eta.shape[2]
    if os.path.isdir(out_dir):
        shutil.rmtree(out_dir)
    os.makedirs(out_dir)

    chi = np.zeros((Ny, Nx), dtype="float32")  # no land yet (Phase 3 adds χ)
    store = zarr.open(out_dir, mode="w")
    store.create_dataset("eta", data=eta, chunks=(1, Ny, Nx))
    store.create_dataset("u", data=u, chunks=(1, Ny, Nx))
    store.create_dataset("v", data=v, chunks=(1, Ny, Nx))
    store.create_dataset("chi", data=chi)
    store.create_dataset("E_k", data=E_k)
    store.create_dataset("E_p", data=E_p)
    json.dump(
        {
            "moon_dist_km": 384000,
            "moon_mass_rel": 1.0,
            "omega_rad_s": omega_rel * EARTH_OMEGA,
            "temperature_C": 15.0,
            "grid_shape": [Ny, Nx],
            "dt_seconds": timestep_s,
            "T_total_steps": T,
            "lat_range": [-90, 90],
            "lon_range": [-180, 180],
        },
        open(os.path.join(out_dir, "metadata.json"), "w"),
    )


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    p = argparse.ArgumentParser(description="Sphere SWE + Coriolis (Phase 1 [K])")
    p.add_argument("--out", default=None)
    p.add_argument("--nphi", type=int, default=128)
    p.add_argument("--ntheta", type=int, default=64)
    p.add_argument("--steps", type=int, default=150)
    p.add_argument("--dt", type=float, default=600.0)
    p.add_argument("--omega", type=float, default=1.0, help="Ω relative to Earth")
    args = p.parse_args()

    here = os.path.dirname(os.path.abspath(__file__))
    out_dir = args.out or os.path.join(here, "data", "scenario_sphere_tc2")

    eta, u, v, E_k, E_p = run_sphere_swe(
        Nphi=args.nphi, Ntheta=args.ntheta, T=args.steps,
        timestep_s=args.dt, omega_rel=args.omega,
    )

    # TC2 steadiness / divergence check
    eta_drift = np.abs(eta[-1] - eta[0]).max() / (np.abs(eta[0]).max() + 1e-12)
    umax0, umax1 = np.abs(u[0]).max(), np.abs(u[-1]).max()
    e_drift = abs(E_k[-1] + E_p[-1] - E_k[0] - E_p[0]) / (E_k[0] + E_p[0] + 1e-12)
    finite = bool(np.isfinite(eta).all() and np.isfinite(u).all())
    logger.info("--- Phase 1 stability check (%d steps) ---", args.steps)
    logger.info("all finite (no divergence): %s", finite)
    logger.info("max|u|: %.3f -> %.3f m/s (TC2 steady ~constant)", umax0, umax1)
    logger.info("eta drift (relative L-inf): %.3e", eta_drift)
    logger.info("total-energy drift (relative): %.3e", e_drift)

    write_zarr(out_dir, eta, u, v, E_k, E_p, args.dt, args.steps, args.omega)
    logger.info("wrote %s  eta%s", out_dir, eta.shape)


if __name__ == "__main__":
    main()
