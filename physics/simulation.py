# Disable threading BEFORE importing numpy/dedalus (Dedalus checks this env var
# at import and warns loudly otherwise; threading hurts its performance).
import os
os.environ.setdefault("OMP_NUM_THREADS", "1")

import json
import shutil
import argparse
import logging

import numpy as np
import dedalus.public as d3

logger = logging.getLogger(__name__)

#physical constants
G = 9.81            # gravity, m/s^2
H0 = 4000.0         # mean ocean depth, m
RHO = 1025.0        # seawater density, kg/m^3
R_EARTH = 6.371e6   # planet radius, m (sets the flat-domain extent)

# Gravity-wave speed c = sqrt(g H0) ≈ 198 m/s (validation target, CLAUDE.md §9).
C_GRAVITY = np.sqrt(G * H0)


def run_flat_swe(
    Nx: int = 128,          # longitude points  -> output axis 1
    Ny: int = 64,           # latitude  points  -> output axis 0
    T: int = 120,           # number of stored timesteps
    timestep: float = 1800.0,  # dt, s (CLAUDE.md schema dt_seconds). NOT named
                            # `dt` — that shadows Dedalus's time-derivative op.
    eta0: float = 1.0,      # initial bump amplitude, m
):
    """Nonlinear rotating-free (flat, no-sphere) Shallow Water on a doubly
    periodic plane — Phase 0 [K].

    State: surface elevation eta (= h) and horizontal velocity u = (u, v).
        dt(u) + g grad(eta) + hyperdiff = -(u.grad)u
        dt(eta) + H0 div(u) + hyperdiff = -div(eta u)

    Gravity-wave terms are linear (LHS) -> handled implicitly by the IMEX
    RK443 timestepper (CLAUDE.md §3.6); advection is the explicit RHS.

    A Gaussian elevation bump radiates concentric gravity waves across the
    periodic box — a clean, recognisable check that the solver runs and that
    waves propagate at c = sqrt(g H0).

    Returns (eta, u, v, E_k, E_p) as geographic-order arrays:
    eta/u/v shape (T, Ny, Nx) = (T, lat, lon); E_k/E_p shape (T,). See §4.4.
    """
    # Flat domain sized to the planet: circumference in x (lon), half in y (lat).
    Lx = 2.0 * np.pi * R_EARTH
    Ly = np.pi * R_EARTH

    dtype = np.float64
    coords = d3.CartesianCoordinates("x", "y")
    dist = d3.Distributor(coords, dtype=dtype)
    xbasis = d3.RealFourier(coords["x"], size=Nx, bounds=(0, Lx), dealias=3 / 2)
    ybasis = d3.RealFourier(coords["y"], size=Ny, bounds=(0, Ly), dealias=3 / 2)

    u = dist.VectorField(coords, name="u", bases=(xbasis, ybasis))
    h = dist.Field(name="h", bases=(xbasis, ybasis))  # surface elevation eta

    # Hyperdiffusion (4th order) damps the grid scale for spectral stability
    # without touching the resolved waves. Tuned to an e-fold of ~20 steps at
    # the Nyquist wavenumber.
    kx_max = np.pi * Nx / Lx
    ky_max = np.pi * Ny / Ly
    k4_max = (kx_max**2 + ky_max**2) ** 2
    nu4 = 1.0 / (20.0 * timestep * k4_max)

    lap = lambda A: d3.lap(A)
    grad = lambda A: d3.grad(A)
    div = lambda A: d3.div(A)

    # locals() misses module-level constants (G, H0); add them explicitly.
    # Dedalus injects the `dt` time-derivative operator into the namespace itself.
    namespace = {**locals(), "G": G, "H0": H0}
    problem = d3.IVP([u, h], namespace=namespace)
    problem.add_equation("dt(u) + G*grad(h) + nu4*lap(lap(u)) = - u@grad(u)")
    problem.add_equation("dt(h) + H0*div(u) + nu4*lap(lap(h)) = - div(h*u)")

    solver = problem.build_solver(d3.RK443)

    # IC: Gaussian elevation bump at the box centre
    x, y = dist.local_grids(xbasis, ybasis)
    x0, y0 = Lx / 2, Ly / 2
    sigma = 0.06 * Lx
    h.change_scales(1)
    h["g"] = eta0 * np.exp(-(((x - x0) ** 2 + (y - y0) ** 2) / (2 * sigma**2)))
    # u starts at rest (already zero-initialised)

    dx, dy = Lx / Nx, Ly / Ny
    dA = dx * dy

    eta_out = np.empty((T, Ny, Nx), dtype="float32")
    u_out = np.empty((T, Ny, Nx), dtype="float32")
    v_out = np.empty((T, Ny, Nx), dtype="float32")
    E_k = np.empty(T, dtype="float32")
    E_p = np.empty(T, dtype="float32")

    for n in range(T):
        # gather current state on the non-dealiased grid, shape (Nx, Ny)
        h.change_scales(1)
        u.change_scales(1)
        eta_g = h["g"]                # (Nx, Ny)  -> .T = (Ny, Nx) = (lat, lon)
        u_g = u["g"][0]               # zonal      (x-component)
        v_g = u["g"][1]               # meridional (y-component)

        eta_out[n] = eta_g.T
        u_out[n] = u_g.T
        v_out[n] = v_g.T

        # energy over the (all-wet) domain (CLAUDE.md §3.5)
        E_k[n] = 0.5 * RHO * H0 * np.sum(u_g**2 + v_g**2) * dA
        E_p[n] = 0.5 * RHO * G * np.sum(eta_g**2) * dA

        if n % 20 == 0:
            logger.info(
                "step %3d/%d  max|eta|=%.4f m  E_tot=%.3e J",
                n, T, np.abs(eta_g).max(), E_k[n] + E_p[n],
            )
        if n < T - 1:
            solver.step(timestep)

    return eta_out, u_out, v_out, E_k, E_p


def write_zarr(out_dir: str, eta, u, v, E_k, E_p, dt: float, T: int):

    import zarr

    Ny, Nx = eta.shape[1], eta.shape[2]
    if os.path.isdir(out_dir):
        shutil.rmtree(out_dir)
    os.makedirs(out_dir)

    chi = np.zeros((Ny, Nx), dtype="float32")  # flat domain: no land (§3.4)

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
            "omega_rad_s": 0.0,           # flat Phase 0: no rotation yet
            "temperature_C": 15.0,
            "grid_shape": [Ny, Nx],
            "dt_seconds": dt,
            "T_total_steps": T,
            "lat_range": [-90, 90],
            "lon_range": [-180, 180],
        },
        open(os.path.join(out_dir, "metadata.json"), "w"),
    )


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    p = argparse.ArgumentParser(description="Flat periodic SWE (Phase 0 [K])")
    p.add_argument("--out", default=None,
                   help="output zarr dir (default: physics/data/scenario_flat_swe_test)")
    p.add_argument("--nx", type=int, default=128)
    p.add_argument("--ny", type=int, default=64)
    p.add_argument("--steps", type=int, default=120)
    p.add_argument("--dt", type=float, default=1800.0)
    args = p.parse_args()

    here = os.path.dirname(os.path.abspath(__file__))
    out_dir = args.out or os.path.join(here, "data", "scenario_flat_swe_test")

    logger.info("c_gravity = sqrt(g H0) = %.1f m/s", C_GRAVITY)
    eta, u, v, E_k, E_p = run_flat_swe(
        Nx=args.nx, Ny=args.ny, T=args.steps, timestep=args.dt
    )
    write_zarr(out_dir, eta, u, v, E_k, E_p, dt=args.dt, T=args.steps)
    logger.info(
        "wrote %s  eta%s  E_k[0]=%.3e E_k[-1]=%.3e",
        out_dir, eta.shape, E_k[0], E_k[-1],
    )


if __name__ == "__main__":
    main()
