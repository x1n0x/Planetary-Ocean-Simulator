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

#  physical constants
G_SI = 9.81                 # surface gravity, m/s^2
H0_SI = 4000.0              # mean ocean depth, m
RHO = 1025.0               # seawater density, kg/m^3
R_SI = 6.371e6             # planet radius, m
EARTH_OMEGA = 7.292e-5     # Earth rotation rate, rad/s

G_GRAV = 6.674e-11         # gravitational constant
M_MOON = 7.342e22          # Moon mass, kg
M_PLANET = 5.972e24        # planet (Earth) mass, kg — sets the moon's orbit
EARTH_MOON_M = 3.84e8      # mean Earth–Moon distance, m

# Unit scaling for spectral conditioning (length by radius, time by the hour).
METER = 1.0 / R_SI
HOUR = 1.0
SECOND = HOUR / 3600.0
LEN_TO_SI = 1.0 / METER             # nondim length -> metres
VEL_TO_SI = SECOND / METER          # nondim speed  -> m/s


def equilibrium_tide_amplitude(moon_dist_m, moon_mass_rel=1.0):
    """Sub-lunar equilibrium tide η₀ = A/g, A = G·M·R²/d³  (CLAUDE.md §3.3, §9).

    Returns η₀ in metres — the validation target is ≈ 0.36 m at the
    Earth–Moon distance (v2 corrected; v1 wrongly had 0.27 m)."""
    A = G_GRAV * (M_MOON * moon_mass_rel) * R_SI**2 / moon_dist_m**3
    return A / G_SI


def make_topography(phi, theta, lat0_deg=30.0, lon0_deg=-60.0,
                    peak_m=5200.0, width_deg=14.0, delta_m=350.0):
    """Variable topography H_b(λ,φ): a smooth seamount whose crest rises above
    mean sea level, plus the volume-penalization mask χ (CLAUDE.md §3.4).

        χ = 0.5·[1 + tanh((H_b − H₀)/δ)]   (0 = ocean, 1 = land)

    Where H_b > H₀ the seamount pokes above the surface → χ→1 → the
    penalization term damps the flow → the tidal wave reflects and its height
    is reduced over the reef.
    """
    lat = np.pi / 2 - theta            # latitude (rad), broadcast (1, Ntheta)
    lat0, lon0 = np.deg2rad(lat0_deg), np.deg2rad(lon0_deg)
    # great-circle-ish distance, longitude scaled by cos(lat)
    dphi = np.angle(np.exp(1j * (phi - lon0)))   # wrapped Δlon in [-π, π]
    d = np.sqrt((lat - lat0) ** 2 + (dphi * np.cos(lat)) ** 2)
    width = np.deg2rad(width_deg)
    H_b = peak_m * np.exp(-(d**2) / (2 * width**2))      # (Nphi, Ntheta)
    chi = 0.5 * (1 + np.tanh((H_b - H0_SI) / delta_m))
    return H_b, chi


def run_tidal_swe(
    Nphi=128, Ntheta=64, T=150, timestep_s=600.0,
    omega_rel=1.0, moon_dist_km=384000.0, moon_mass_rel=1.0,
    with_topography=True, drag_days=0.25,
    event_step=None, event_amp_m=2.5, event_lat_deg=-25.0, event_lon_deg=-120.0,
    noise_floor_m=0.0, moons=None,
):
    """Rotating SWE on the sphere with single-moon tidal forcing and
    volume-penalization topography — Phase 2 [K].

        dt(u) + g·grad(η) + 2Ω·zcross(u) + r·u + hyperdiff
                                  = -(u·grad)u + grad(U_tidal) - (χ/τ_p)·u
        dt(η) + H₀·div(u) + hyperdiff = -div(η·u)

    The sub-lunar point sweeps in longitude at Ω_planet − n_moon (n_moon from
    Kepler for the given distance), so η develops a semidiurnal tidal bulge
    that tracks the moon. Linear drag r relaxes the dynamic tide toward the
    equilibrium tide.
    """
    dtype = np.float64
    coords = d3.S2Coordinates("phi", "theta")
    dist = d3.Distributor(coords, dtype=dtype)
    basis = d3.SphereBasis(
        coords, (Nphi, Ntheta), radius=R_SI * METER, dealias=3 / 2, dtype=dtype
    )

    u = dist.VectorField(coords, name="u", bases=basis)
    h = dist.Field(name="h", bases=basis)          # surface elevation η
    Utide = dist.Field(name="Utide", bases=basis)  # tidal potential (updated/step)
    chi = dist.Field(name="chi", bases=basis)      # static penalization mask

    # nondim parameters
    g = G_SI * METER / SECOND**2
    H0 = H0_SI * METER
    Omega = (omega_rel * EARTH_OMEGA) / SECOND

    timestep = timestep_s * SECOND
    ell_max = Ntheta
    nu4 = 1.0 / (10.0 * timestep * (ell_max * (ell_max + 1)) ** 2)
    # Rayleigh drag — strong enough to suppress the global-resonance growth of
    # a uniform-depth ocean and relax the dynamic tide toward equilibrium.
    r_drag = 1.0 / ((drag_days * 86400.0) * SECOND)
    tau_p = (5.0 * timestep_s) * SECOND            # penalization ~5 steps

    zcross = lambda A: d3.MulCosine(d3.skew(A))
    lap = lambda A: d3.lap(A)
    grad = lambda A: d3.grad(A)
    div = lambda A: d3.div(A)

    ns = {**locals(), "g": g, "H0": H0, "Omega": Omega, "nu4": nu4,
          "r_drag": r_drag, "tau_p": tau_p}
    problem = d3.IVP([u, h], namespace=ns)
    problem.add_equation(
        "dt(u) + g*grad(h) + 2*Omega*zcross(u) + r_drag*u + nu4*lap(lap(u))"
        " = - u@grad(u) + grad(Utide) - (chi/tau_p)*u"
    )
    # Surface penalization too: over land (χ→1) drive η→0, so a reef breaking
    # the surface has no free-surface wave — its wave height is suppressed
    # rather than reflected into a pile-up (CLAUDE.md §3.4 intent).
    problem.add_equation(
        "dt(h) + H0*div(u) + nu4*lap(lap(h)) = - div(h*u) - (chi/tau_p)*h"
    )
    solver = problem.build_solver(d3.RK443)

    # grids and static fields
    phi, theta = dist.local_grids(basis)           # phi (Nphi,1), theta (1,Ntheta)
    H_b, chi_arr = make_topography(phi, theta)
    if not with_topography:
        chi_arr = np.zeros_like(chi_arr)
        H_b = np.zeros_like(H_b)
    chi.change_scales(1)
    chi["g"] = chi_arr

    # Moon set: single equatorial moon by default, or a superposed list for
    # multi-moon scenarios. U_tidal = Σ_i A_i·P₂(cosγ_i)  (CLAUDE.md §3.3, §4.x).
    if moons is None:
        moons = [{"dist_km": moon_dist_km, "mass_rel": moon_mass_rel,
                  "lat0_deg": 0.0, "lon0_deg": 0.0}]
    moon_params = []
    for mn in moons:
        d_m = mn["dist_km"] * 1000.0
        A_nd_i = (G_GRAV * (M_MOON * mn["mass_rel"]) * R_SI**2 / d_m**3) \
            * METER**2 / SECOND**2
        n_i = np.sqrt(G_GRAV * M_PLANET / d_m**3)        # Kepler orbital rate
        moon_params.append({
            "A": A_nd_i,
            "omega_sub": omega_rel * EARTH_OMEGA - n_i,  # regression rate (SI)
            "lat": np.deg2rad(mn.get("lat0_deg", 0.0)),  # declination
            "lon0": np.deg2rad(mn.get("lon0_deg", 0.0)),
        })

    cos_th, sin_th = np.cos(theta), np.sin(theta)   # = sin(lat), cos(lat)

    def set_tide(t_si):
        # cosγ = sin(lat)sin(δ) + cos(lat)cos(δ)cos(λ−λ_moon); superpose moons
        acc = 0.0
        for mp in moon_params:
            lam = mp["lon0"] - mp["omega_sub"] * t_si
            cosg = (cos_th * np.sin(mp["lat"])
                    + sin_th * np.cos(mp["lat"]) * np.cos(phi - lam))
            acc = acc + mp["A"] * 0.5 * (3.0 * cosg**2 - 1.0)
        Utide.change_scales(1)
        Utide["g"] = acc

    # energy diagnostics (wet area only, ∝ sinθ)
    wet = (chi_arr < 0.5)
    dtheta, dphi = np.pi / Ntheta, 2 * np.pi / Nphi
    area = (R_SI**2) * np.sin(theta) * dtheta * dphi

    eta_out = np.empty((T, Ntheta, Nphi), dtype="float32")
    u_out = np.empty((T, Ntheta, Nphi), dtype="float32")
    v_out = np.empty((T, Ntheta, Nphi), dtype="float32")
    E_k = np.empty(T, dtype="float32")
    E_p = np.empty(T, dtype="float32")
    # Dedalus grids: theta DESCENDING (so .T rows are already south-first)
    # and phi starting at 0, while the schema puts lon -180 at col 0 —
    # roll by half a revolution. (v1 wrongly flipped lat and skipped the roll.)
    to_geo = lambda a: np.roll(a.T, -(Nphi // 2), axis=1).copy()

    # optional seafloor-displacement event (a tsunami source) — a localized η
    # uplift injected at one step. Radiates a wave packet that the anomaly
    # detectors flag and that shows up as an energy spike — gives the DS
    # pipeline real data to fire on (CLAUDE.md §6).
    ev_lat, ev_lon = np.deg2rad(event_lat_deg), np.deg2rad(event_lon_deg)
    ev_dphi = np.angle(np.exp(1j * (phi - ev_lon)))
    ev_d = np.sqrt((np.pi / 2 - theta - ev_lat) ** 2 + (ev_dphi * np.sin(theta)) ** 2)
    ev_bump = (event_amp_m * METER) * np.exp(-(ev_d**2) / (2 * np.deg2rad(6) ** 2))

    eta_peak = 0.0
    for n in range(T):
        set_tide(n * timestep_s)                   # update moon position
        if event_step is not None and n == event_step:
            h.change_scales(1)
            h["g"] = h["g"] + ev_bump              # inject the tsunami source
        h.change_scales(1); u.change_scales(1)
        eta_si = h["g"] * LEN_TO_SI
        u_si = u["g"][0] * VEL_TO_SI
        v_si = -u["g"][1] * VEL_TO_SI

        eta_out[n] = to_geo(eta_si)
        u_out[n] = to_geo(u_si)
        v_out[n] = to_geo(v_si)
        E_k[n] = 0.5 * RHO * H0_SI * np.sum((u_si**2 + v_si**2) * area * wet)
        E_p[n] = 0.5 * RHO * G_SI * np.sum((eta_si**2) * area * wet)
        eta_peak = max(eta_peak, np.abs(eta_si[wet]).max())

        if n % 25 == 0:
            logger.info("step %3d/%d  max|eta|=%.3f m  max|u|=%.3f m/s",
                        n, T, np.abs(eta_si).max(), np.abs(u_si).max())
        if n < T - 1:
            solver.step(timestep)

    chi_geo = to_geo(chi_arr).astype("float32")

    # Observational noise floor: a small per-frame η noise so the z-score
    # anomaly detector isn't over-sensitive in calm cells (it divides by the
    # window std). Without it, near-zero-variance cells trip on any change.
    if noise_floor_m > 0:
        rng = np.random.default_rng(0)
        eta_out += rng.normal(0, noise_floor_m, eta_out.shape).astype("float32")
        eta_out[:, chi_geo > 0.5] = 0.0   # keep land clean

    return eta_out, u_out, v_out, chi_geo, E_k, E_p, eta_peak


def write_zarr(out_dir, eta, u, v, chi, E_k, E_p, *, timestep_s, T,
               omega_rel, moon_dist_km, moon_mass_rel, temp_c):
    import zarr
    Ny, Nx = eta.shape[1], eta.shape[2]
    if os.path.isdir(out_dir):
        shutil.rmtree(out_dir)
    os.makedirs(out_dir)
    store = zarr.open(out_dir, mode="w")
    store.create_dataset("eta", data=eta, chunks=(1, Ny, Nx))
    store.create_dataset("u", data=u, chunks=(1, Ny, Nx))
    store.create_dataset("v", data=v, chunks=(1, Ny, Nx))
    store.create_dataset("chi", data=chi)
    store.create_dataset("E_k", data=E_k)
    store.create_dataset("E_p", data=E_p)
    json.dump(
        {
            "moon_dist_km": moon_dist_km,
            "moon_mass_rel": moon_mass_rel,
            "omega_rad_s": omega_rel * EARTH_OMEGA,
            "temperature_C": temp_c,
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
    p = argparse.ArgumentParser(description="Tidal SWE + topography (Phase 2 [K])")
    p.add_argument("--out", default=None)
    p.add_argument("--nphi", type=int, default=128)
    p.add_argument("--ntheta", type=int, default=64)
    p.add_argument("--steps", type=int, default=150)
    p.add_argument("--dt", type=float, default=600.0)
    p.add_argument("--omega", type=float, default=1.0)
    p.add_argument("--moon-km", type=float, default=384000.0)
    p.add_argument("--moon-mass", type=float, default=1.0)
    p.add_argument("--temp", type=float, default=15.0)
    p.add_argument("--no-topo", action="store_true")
    p.add_argument("--drag-days", type=float, default=0.25)
    p.add_argument("--event-step", type=int, default=None,
                   help="inject a tsunami source at this timestep")
    args = p.parse_args()

    here = os.path.dirname(os.path.abspath(__file__))
    out_dir = args.out or os.path.join(here, "data", "scenario_tide_moon384km_omega1x_temp15")

    # equilibrium-tide validation (CLAUDE.md §9)
    eta0 = equilibrium_tide_amplitude(args.moon_km * 1000.0, args.moon_mass)
    logger.info("=== equilibrium tide validation ===")
    logger.info("η₀ = A/g = %.4f m  (target ≈ 0.36 m)  [moon %dkm, mass %.1f×]",
                eta0, int(args.moon_km), args.moon_mass)
    logger.info("within 0.34–0.38 m of target: %s", 0.34 <= eta0 <= 0.38)

    out = run_tidal_swe(
        Nphi=args.nphi, Ntheta=args.ntheta, T=args.steps, timestep_s=args.dt,
        omega_rel=args.omega, moon_dist_km=args.moon_km,
        moon_mass_rel=args.moon_mass, with_topography=not args.no_topo,
        drag_days=args.drag_days, event_step=args.event_step,
    )
    eta, u, v, chi, E_k, E_p, eta_peak = out
    land_cells = int((chi > 0.5).sum())
    logger.info("dynamic tide: peak |η| over wet ocean = %.3f m", eta_peak)
    logger.info("topography: %d land cells (χ>0.5)", land_cells)

    write_zarr(out_dir, eta, u, v, chi, E_k, E_p,
               timestep_s=args.dt, T=args.steps, omega_rel=args.omega,
               moon_dist_km=args.moon_km, moon_mass_rel=args.moon_mass,
               temp_c=args.temp)
    logger.info("wrote %s  eta%s", out_dir, eta.shape)


if __name__ == "__main__":
    main()
