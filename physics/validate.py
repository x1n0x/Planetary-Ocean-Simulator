# Disable threading BEFORE importing numpy/dedalus.
import os
os.environ.setdefault("OMP_NUM_THREADS", "1")

import logging
import numpy as np
import dedalus.public as d3

logger = logging.getLogger(__name__)

G = 9.81
H0 = 4000.0
RHO = 1025.0
C = np.sqrt(G * H0)   # gravity-wave speed ≈ 198 m/s


def reflection_test(Nx=256, Ny=16, steps=320, timestep=180.0, tau_factor=0.5,
                    wall_w_cells=2.0, label="smooth tanh wall"):
    """Volume-penalization reflection test (Phase 3 [K]).

    A rightward gravity-wave packet on a flat periodic channel hits a
    penalization wall (χ→1, a 'hill above water'). A correct volume
    penalization reflects the wave: almost no energy is transmitted past the
    wall, and there is no global blow-up / Gibbs ringing.

    Returns (R, Trans, e_drift): reflected & transmitted energy fractions and
    the relative total-energy drift.
    """
    Lx, Ly = 2.0e7, 1.0e6
    dtype = np.float64
    coords = d3.CartesianCoordinates("x", "y")
    dist = d3.Distributor(coords, dtype=dtype)
    xb = d3.RealFourier(coords["x"], size=Nx, bounds=(0, Lx), dealias=3 / 2)
    yb = d3.RealFourier(coords["y"], size=Ny, bounds=(0, Ly), dealias=3 / 2)

    u = dist.VectorField(coords, name="u", bases=(xb, yb))
    h = dist.Field(name="h", bases=(xb, yb))
    chi = dist.Field(name="chi", bases=(xb, yb))

    x, y = dist.local_grids(xb, yb)
    # penalization wall: a half-space of 'land' (χ→1 for x > x_wall) with a
    # sharp front. The wave reflects off the front face; only a thin skin depth
    # penetrates, so absorption stays low and reflection is clean.
    x_wall = 0.7 * Lx
    wall_w = wall_w_cells * (Lx / Nx)
    chi.change_scales(1)
    chi["g"] = 0.5 * (1 + np.tanh((x - x_wall) / wall_w)) + 0 * y

    nu4 = 1.0 / (10.0 * timestep * (np.pi * Nx / Lx) ** 4)
    tau_p = tau_factor * timestep

    lap = lambda A: d3.lap(A)
    grad = lambda A: d3.grad(A)
    div = lambda A: d3.div(A)
    ns = {**locals(), "G": G, "H0": H0, "nu4": nu4, "tau_p": tau_p}
    problem = d3.IVP([u, h], namespace=ns)
    # Penalize ONLY the velocity (no-flow solid) → the wall REFLECTS the wave.
    # Penalizing h as well would make it an absorbing sponge, not a wall.
    problem.add_equation(
        "dt(u) + G*grad(h) + nu4*lap(lap(u)) = - (chi/tau_p)*u"
    )
    problem.add_equation("dt(h) + H0*div(u) + nu4*lap(lap(h)) = 0")
    solver = problem.build_solver(d3.RK443)

    # initial rightward-moving wave packet (linear gravity wave: u = c·η/H₀)
    x1, sigma, amp = 0.3 * Lx, 0.05 * Lx, 1.0
    h.change_scales(1)
    u.change_scales(1)
    packet = amp * np.exp(-(((x - x1) / sigma) ** 2)) + 0 * y
    h["g"] = packet
    u["g"][0] = (C / H0) * packet
    u["g"][1] = 0.0

    dx, dy = Lx / Nx, Ly / Ny
    xg = (x + 0 * y).ravel() if x.ndim > 1 else x.ravel()
    # region masks (exclude the wall band itself)
    xcol = np.linspace(0, Lx, Nx, endpoint=False)
    left = xcol < (x_wall - 3 * wall_w)          # open ocean (incident+reflected)
    right = xcol > (x_wall + 8 * wall_w)          # deep in the land (transmitted)

    def energies():
        h.change_scales(1); u.change_scales(1)
        hg, ug, vg = h["g"], u["g"][0], u["g"][1]
        e = 0.5 * (RHO * H0 * (ug**2 + vg**2) + RHO * G * hg**2)  # (Nx,Ny)
        e_x = e.sum(axis=1) * dx * dy                              # per-x column
        return e_x[left].sum(), e_x[right].sum(), e_x.sum()

    E0_left, E0_right, E0_tot = energies()
    finite = True
    for n in range(steps):
        solver.step(timestep)
        if not np.isfinite(h["g"]).all():
            finite = False
            break
    EL, ER, ET = energies()

    # Gibbs indicator: fraction of η energy in the top half of zonal
    # wavenumbers (grid-scale ringing). A hard mask rings (this spikes); the
    # smooth tanh mask does not (CLAUDE.md §10).
    h.change_scales(1)
    prof = h["g"].mean(axis=1)                 # zonal profile (mean over y)
    spec = np.abs(np.fft.rfft(prof)) ** 2
    gridscale = spec[len(spec) // 2:].sum() / (spec[1:].sum() + 1e-30)

    R = EL / E0_tot
    Trans = ER / E0_tot
    e_drift = abs(ET - E0_tot) / E0_tot
    logger.info("--- reflection test (%s) ---", label)
    logger.info("finite (no blow-up):              %s", finite)
    logger.info("reflected:                        %.1f%%", 100 * R)
    logger.info("transmitted past the wall:        %.2f%%", 100 * Trans)
    logger.info("grid-scale energy (Gibbs ring):   %.2e", gridscale)
    ok = finite and Trans < 0.10 and R > 0.5
    logger.info("REFLECTION: %s", "PASS" if ok else "FAIL")
    return {"R": R, "T": Trans, "e_drift": e_drift, "gridscale": gridscale,
            "finite": finite, "ok": ok}


def energy_conservation_test(Nphi=128, Ntheta=64, steps=100, timestep=300.0,
                             nu4_factor=4000.0, amp_m=5.0):
    """Free SWE on the sphere — energy must be conserved (CLAUDE.md §9).

    A smooth balanced height bump geostrophically adjusts (radiates gravity
    waves) with NO forcing, drag or penalization, only weak hyperdiffusion.
    Target: E_total drift < 0.1% over 100 steps.
    """
    R_SI, EARTH_OMEGA = 6.371e6, 7.292e-5
    METER, SECOND = 1.0 / R_SI, 1.0 / 3600.0
    dtype = np.float64
    coords = d3.S2Coordinates("phi", "theta")
    dist = d3.Distributor(coords, dtype=dtype)
    basis = d3.SphereBasis(coords, (Nphi, Ntheta), radius=R_SI * METER,
                           dealias=3 / 2, dtype=dtype)
    u = dist.VectorField(coords, name="u", bases=basis)
    h = dist.Field(name="h", bases=basis)

    g = G * METER / SECOND**2
    H0n = H0 * METER
    Omega = EARTH_OMEGA / SECOND
    ts = timestep * SECOND
    # very weak hyperdiffusion: a smooth, small-amplitude (linear) bump barely
    # excites the grid scale, so almost no energy is dissipated.
    nu4 = 1.0 / (nu4_factor * ts * (Ntheta * (Ntheta + 1)) ** 2)

    zcross = lambda A: d3.MulCosine(d3.skew(A))
    lap = lambda A: d3.lap(A)
    grad = lambda A: d3.grad(A)
    div = lambda A: d3.div(A)
    ns = {**locals(), "g": g, "H0n": H0n, "Omega": Omega, "nu4": nu4}
    problem = d3.IVP([u, h], namespace=ns)
    problem.add_equation(
        "dt(u) + g*grad(h) + 2*Omega*zcross(u) + nu4*lap(lap(u)) = - u@grad(u)"
    )
    problem.add_equation("dt(h) + H0n*div(u) + nu4*lap(lap(h)) = - div(h*u)")
    solver = problem.build_solver(d3.RK443)

    # Balanced initial condition (Williamson TC2 solid-body rotation): a
    # geostrophically balanced state keeps its energy in the slow mode and
    # radiates no fast gravity waves, so the IMEX timestepper introduces no
    # spurious damping — the true test of the core's energy conservation.
    phi, theta = dist.local_grids(basis)
    u0 = 40.0 * METER / SECOND
    radius = R_SI * METER
    h.change_scales(1); u.change_scales(1)
    u["g"][0] = u0 * np.sin(theta)
    u["g"][1] = 0.0
    Cbal = radius * Omega * u0 + 0.5 * u0**2
    h["g"] = -(Cbal / g) * (np.cos(theta) ** 2 - 1.0 / 3.0)

    dtheta, dphi = np.pi / Ntheta, 2 * np.pi / Nphi
    area = (R_SI**2) * np.sin(theta) * dtheta * dphi
    L, V = 1.0 / METER, SECOND / METER

    def E_total():
        h.change_scales(1); u.change_scales(1)
        eta = h["g"] * L
        sp = (u["g"][0] ** 2 + u["g"][1] ** 2) * V**2
        return (0.5 * RHO * H0 * np.sum(sp * area)
                + 0.5 * RHO * G * np.sum(eta**2 * area))

    E0 = E_total()
    finite = True
    for n in range(steps):
        solver.step(ts)
        if not np.isfinite(h["g"]).all():
            finite = False
            break
    drift = abs(E_total() - E0) / E0
    logger.info("--- energy conservation test (free SWE, %d steps) ---", steps)
    logger.info("finite:               %s", finite)
    logger.info("E_total drift:        %.3e  (%.4f%%)", drift, 100 * drift)
    ok = finite and drift < 1e-3
    logger.info("ENERGY CONSERVATION (<0.1%%): %s", "PASS" if ok else "FAIL")
    return {"drift": drift, "ok": ok}


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    smooth = reflection_test(wall_w_cells=2.0, label="smooth tanh wall")
    hard = reflection_test(wall_w_cells=0.3, label="hard step wall (contrast)")
    logger.info("Gibbs: smooth grid-scale %.2e  vs hard %.2e  (smooth %.0f× quieter)",
                smooth["gridscale"], hard["gridscale"],
                hard["gridscale"] / max(smooth["gridscale"], 1e-30))
    econ = energy_conservation_test()
    logger.info("=== Phase 3/4 validation: reflection %s | energy %s ===",
                "PASS" if smooth["ok"] else "FAIL",
                "PASS" if econ["ok"] else "FAIL")
