# physics/ — Dedalus SWE solver (Kirill's domain)

Produces zarr scenario stores matching the data contract in
[CLAUDE.md §4](../CLAUDE.md). The backend reads these directly; the zarr schema
is the only hard coupling between physics and frontend.

## Setup (conda — required)

Dedalus v3 is not reliably pip-installable. Use conda-forge:

```bash
conda create -n ocean -c conda-forge python=3.12 dedalus "zarr=2.18.*" -y
conda activate ocean
python -c "import dedalus.public as d3; print('dedalus OK')"
```

`zarr` is pinned to `2.18.*` so the store format (zarr v2, blosc/lz4) matches
the FastAPI backend's reader exactly.

> Set `OMP_NUM_THREADS=1` when running — Dedalus is single-threaded per process
> and warns otherwise. The scripts set this automatically.

## Phase 0 — flat periodic SWE

[`simulation.py`](simulation.py) solves the nonlinear shallow-water equations on
a flat, doubly-periodic plane (no sphere, no rotation yet):

```
dt(u)   + g·grad(η) + hyperdiff = −(u·grad)u
dt(η)   + H₀·div(u) + hyperdiff = −div(η·u)
```

- IMEX **RK443** timestepper; gravity-wave terms implicit, advection explicit (§3.6)
- Initial condition: a Gaussian elevation bump that radiates gravity waves at
  `c = √(gH₀) ≈ 198 m/s`
- 4th-order hyperdiffusion damps the grid scale for spectral stability

Run it:

```bash
python simulation.py                       # 128×64, 120 steps -> physics/data/scenario_flat_swe_test
python simulation.py --nx 64 --ny 32 --steps 40 --out /tmp/quick   # smaller/faster
```

Output is a full scenario store (`eta`, `u`, `v`, `chi`, `E_k`, `E_p`,
`metadata.json`) in geographic order `(T, lat, lon)`, chunked `(1, lat, lon)`.

## Phase 1 — sphere SWE + Coriolis

[`sphere_swe.py`](sphere_swe.py) moves to the **full sphere** with
`d3.SphereBasis` (NOT `S2Basis`) and full-sphere Coriolis `f(φ)=2Ω·sin(φ)` via
the Dedalus idiom `zcross(u) = MulCosine(skew(u))` (MulCosine multiplies by
cos(colatitude) = sin(latitude)):

```
dt(u) + g·grad(η) + 2Ω·zcross(u) + hyperdiff = -(u·grad)u
dt(η) + H₀·div(u)                + hyperdiff = -div(η·u)
```

Initial condition: **Williamson et al. (1992) Test Case 2** — solid-body
rotation in exact geostrophic balance, a *steady* analytic solution. If Coriolis
is correct the state barely moves, so a tiny drift over 100+ steps validates
both stability and the Coriolis term.

```bash
python sphere_swe.py                 # 128×64, 150 steps -> physics/data/scenario_sphere_tc2
python sphere_swe.py --omega 5       # 5× Earth rotation
```

Verified (150 steps, 128×64): no divergence, max|u| constant at 19.99 m/s,
total-energy drift ~3e-5, eta drift ~2e-5; output is equator-symmetric with the
expected equatorial bulge — confirming latitude orientation and Coriolis.

## Phase 2 — tidal forcing + topography (first real handoff)

[`tidal_swe.py`](tidal_swe.py) adds, on top of the Phase 1 sphere solver:

- **Single-moon tidal forcing** `grad(U_tidal)`, `U_tidal = A·P₂(cosγ)`,
  `A = G·M·R²/d³` (§3.3). The sub-lunar point sweeps westward at
  `Ω_planet − n_moon` (n_moon from Kepler), so η grows a semidiurnal bulge
  that tracks the moon.
- **Variable topography** `H_b(λ,φ)` → volume-penalization mask
  `χ = ½[1+tanh((H_b−H₀)/δ)]` (§3.4). Velocity *and* surface are penalized
  over land, so a reef that breaks the surface reflects the flow and reduces
  the wave height over it.
- **Linear (Rayleigh) drag** that suppresses the global-resonance growth of a
  uniform-depth ocean and relaxes the dynamic tide to equilibrium.

```bash
python tidal_swe.py --steps 200          # -> physics/data/scenario_tide_moon384km_omega1x_temp15
python tidal_swe.py --moon-km 192000     # closer moon: stronger tide (∝ d⁻³)
```

Validated (128×64, 200 steps):
- **equilibrium tide η₀ = A/g = 0.358 m** ✓ (target ≈ 0.36 m, CLAUDE.md §9)
- dynamic tide saturates at ~0.35 m, bounded
- bulge tracks the moon: zonal m=2 phase advances at 0.99 × 2·ω_sub
- reef reduces wave height ~1.4× vs open ocean

This scenario is the **first real handoff** — copied into `backend/data/` for
Vlad. `eta` ≈ ±0.35 m so it renders with a proper colour gradient on the globe
(unlike the high-amplitude TC2 test).

## Phase 3 — reflection validation + scenario library

**Volume-penalization reflection** — [`validate.py`](validate.py): a gravity-wave
packet on a flat channel hits a penalization wall ('hill above water'). Result:
**0% transmitted** (the wave is blocked), **62% reflected**, no blow-up/Gibbs.
The remaining ~36% is dissipated in the penalization skin — inherent to simple
Brinkman penalization. `python validate.py`.

**Real scenario library** — [`generate_scenarios.py`](generate_scenarios.py):
precomputes the full library (replaces the fake one in `backend/data/`):

| Ω (×Earth) | moon | note |
|---|---|---|
| 0.1, 1, 3, 5 | 384 000 km | Ω slider range; Coriolis suppresses the tide at high Ω |
| 1 | 192 000 km | closer moon → η₀ = 2.86 m (8× stronger, d⁻³) |
| 1 | 384 000 km, 28 °C | warm variant |

Each scenario carries the reef topography (`chi.zarr` for Vlad's terrain
overlay), the moon tide, a small observational η-noise floor (0.03 m, so the
z-score detector isn't over-sensitive), and an injected **seafloor-displacement
event** (tsunami) at t=90 — which produces a clear energy spike (severity ≈14)
and a localized anomaly cluster, so the DS pipeline fires on real data.

```bash
python generate_scenarios.py     # -> physics/data/scenario_moon*  (then copy to backend/data/)
```

> Note: a z-score detector also flags the *moving* tidal fronts (~2% of cells) —
> realistic behaviour of z-score on a periodic signal. The energy-spike detector
> cleanly isolates the tsunami event.

## Phase 4 — multi-moon, 20+ library, validations

- **Multiple moons** ([`tidal_swe.py`](tidal_swe.py) `moons=[...]`): `U_tidal` is
  superposed over a list of moons, each with its own mass, distance, declination
  and start longitude.
- **20+ scenario library** ([`generate_scenarios.py`](generate_scenarios.py)):
  the full Ω×distance grid (Ω ∈ {0.1,1,3,5}×, d ∈ {192,384,768,1152} km) + two
  temperature variants + three multi-moon scenarios = **21 scenarios** covering
  the slider ranges. `python generate_scenarios.py` → copy `physics/data/*` into
  `backend/data/`.
- **Validations** ([`validate.py`](validate.py), `python validate.py`):
  - **Energy conservation** — free balanced SWE: E_total drift **4.9e-8** over
    100 steps (≪ 0.1%). (An *unbalanced* IC instead floors at ~0.3% — that is the
    IMEX timestepper damping radiated gravity waves, not a discretization leak.)
  - **Land reflection / no Gibbs** — wave on the smooth tanh mask: 0% transmitted,
    62% reflected, no blow-up; grid-scale (ringing) energy is **9× lower** than a
    hard step mask — validating the volume-penalization design (CLAUDE.md §10).

## Handoff

`physics/data/` is git-ignored (large). To hand a scenario to the backend, copy
the store into `backend/data/` (also git-ignored); the backend picks it up on
startup. Sphere, Coriolis, tidal forcing and topography land in later phases.
