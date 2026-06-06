# PLANETARY OCEAN SIMULATOR — Claude Code Context

> **Full project context for Claude Code.**  
> Physics spec: v2 (full-sphere SWE, SphereBasis, IMEX RK443, volume-penalization topography).  
> Read this file entirely before touching any code.

---

## 1. Project Summary

An interactive water-planet simulator in the browser. The user views a full spherical
ocean world from above (Google Earth aesthetic), drags sliders to manipulate physical
parameters, and watches the ocean respond in real time: waves, tides, currents, anomalies.

**Two developers, two codebases, one data contract:**

| Developer | Codebase | Deliverable |
|---|---|---|
| **Friend (physics/math)** | `physics/` — Python, Dedalus v3 | Zarr stores of ocean state |
| **Vlad (frontend + DS)** | `frontend/` + `backend/` — TS + Python | CesiumJS globe + FastAPI |

The **only hard coupling** is the zarr schema in Section 4. Everything else is independent.

---

## 2. Repository Structure

```
ocean-sim/
├── CLAUDE.md                  ← this file
├── physics/                   ← friend's domain, DO NOT edit
│   ├── simulation.py          # Dedalus SWE solver
│   ├── generate_scenarios.py  # precompute scenario library
│   ├── validate.py            # validation tests
│   └── requirements.txt
├── backend/                   ← Vlad's FastAPI
│   ├── main.py
│   ├── routers/
│   │   ├── state.py           # GET /state, GET /land
│   │   ├── scenarios.py       # GET /scenarios
│   │   └── anomaly.py         # GET /anomaly
│   ├── services/
│   │   ├── zarr_reader.py
│   │   └── anomaly.py         # detection logic
│   ├── data/                  # zarr stores (gitignored, large)
│   ├── models/                # joblib sklearn models (gitignored)
│   └── requirements.txt
├── frontend/                  ← Vlad's React app
│   ├── src/
│   │   ├── components/
│   │   │   ├── Globe.tsx
│   │   │   ├── ControlPanel.tsx
│   │   │   ├── EnergyChart.tsx
│   │   │   ├── OmegaBadge.tsx
│   │   │   └── AnomalyOverlay.tsx
│   │   ├── hooks/
│   │   │   └── useOceanState.ts
│   │   ├── utils/
│   │   │   ├── textures.ts    # eta/anomaly → ImageData
│   │   │   └── scenarios.ts   # nearest-scenario logic
│   │   └── App.tsx
│   ├── package.json
│   └── vite.config.ts
└── docker-compose.yml
```

---

## 3. Physics Model (read-only reference for Vlad)

> You do not write physics code. This section is here so you understand
> what the data means and can render it correctly.

### 3.1 Governing equations

Full nonlinear rotating Shallow Water Equations on a sphere:

```
∂u/∂t + (u·∇)u + f·k̂×u = −g∇η + ∇U_tidal + F_drag + F_land   (momentum)
∂η/∂t + ∇·(Hu) = 0                                               (continuity)
H = H₀ + η − H_b                                                 (total depth)
```

Variables:
- `u = (u, v)` — depth-averaged horizontal velocity (m/s)
- `η` — surface elevation anomaly / wave height (m)
- `H` — total water column depth (m)
- `H₀ = 4000 m` — mean ocean depth
- `H_b(λ,φ)` — bottom topography (ridges, seamounts; user-drawn)
- `χ` — smoothed land mask: 0 = ocean, 1 = land
- `f(φ) = 2Ω·sin(φ)` — Coriolis parameter, FULL SPHERE (not beta-plane)
- `g = 9.81 m/s²`

### 3.2 Coriolis — full sphere

**Physics v2 dropped beta-plane.** The full latitude-varying Coriolis is used:

```
f(φ) = 2Ω·sin(φ)
```

The user's `Ω` slider scales the rotation rate. At `Ω = 0` → no rotation.
At `Ω = 5×Ω_Earth` → strong zonal jets emerge. This is the most visually
interesting new control.

### 3.3 Tidal forcing

```
U_tidal(γ) = (GM·R²/d³)·P₂(cos γ)
           = (GM·R²)/(2d³) · (3cos²γ − 1)
```

Where `γ` = great-circle angle from sub-lunar point, `d` = moon distance.
Tidal amplitude ∝ d⁻³: halving distance → 8× stronger tides.

**Validation target (physics v2 corrected):** single Moon at Earth-Moon distance
→ equilibrium tide amplitude `η₀ ≈ 0.36 m` (NOT 0.27 m from v1).

### 3.4 Topography / land

Hills above sea level reflect water via volume penalization:

```
F_land = −(χ/τ_p)·u
χ = 0.5·[1 + tanh((H_b − H₀ − η)/δ)]    ← smoothed mask, NOT a hard step
```

`χ` is stored in `chi.zarr`. It is time-independent (unless user redraws terrain).
**Land cells must never be flagged as anomalies.**

### 3.5 Energy diagnostics (wet area only)

```
E_k(t) = ½∫∫ ρ₀·H·|u|²  dA   (over wet cells only)
E_p(t) = ½∫∫ ρ₀·g·η²    dA   (over wet cells only)
```

When land is present, absolute `E_k` values are lower. The spike ratio is unaffected.

### 3.6 Solver details

- Solver: **Dedalus v3**, `SphereBasis` (NOT `S2Basis` — v1 was wrong)
- Timestepper: **RK443** — 4-stage, **3rd-order IMEX** (NOT explicit 4th-order — v1 was wrong)
- Coordinates: `S2Coordinates('phi', 'theta')` where `phi=λ` (longitude), `theta=colatitude`
- Grid: 32×32 (dev), 128×64 (production precompute)
- Step time: ~1–5 ms (32²), ~100–500 ms (128×64)

---

## 4. Data Contract — Zarr Schema (THE HARD INTERFACE)

> This is the single point of coupling between physics and frontend.
> Do NOT change this schema without coordinating with the physics developer.

### 4.1 Directory layout per scenario

```
data/
└── scenario_moon384km_omega1x_temp15/
    ├── eta.zarr        # surface elevation  shape: (T, lat, lon)  float32
    ├── u.zarr          # zonal velocity     shape: (T, lat, lon)  float32
    ├── v.zarr          # meridional vel     shape: (T, lat, lon)  float32
    ├── chi.zarr        # land mask          shape: (lat, lon)     float32  [static]
    ├── E_k.zarr        # kinetic energy     shape: (T,)           float32
    ├── E_p.zarr        # potential energy   shape: (T,)           float32
    └── metadata.json
```

### 4.2 metadata.json schema

```json
{
  "moon_dist_km":   384000,
  "moon_mass_rel":  1.0,
  "omega_rad_s":    7.292e-5,
  "temperature_C":  15.0,
  "grid_shape":     [64, 128],
  "dt_seconds":     1800,
  "T_total_steps":  17520,
  "lat_range":      [-90, 90],
  "lon_range":      [-180, 180]
}
```

### 4.3 Chunking

All 3D arrays MUST be chunked as `(1, lat, lon)` — one timestep per chunk.
This allows O(1) single-timestep reads in FastAPI.

### 4.4 Coordinate convention

- Zarr arrays stored in **geographic order**: axis 0 = latitude (south→north), axis 1 = longitude (west→east)
- Matches GeoJSON / CesiumJS `[-180, -90, 180, 90]` bounds convention
- Dedalus internal order is `(phi=lon, theta=colatitude)` — conversion done by physics developer

---

## 5. Backend — FastAPI

### 5.1 Tech stack

```
Python 3.11+
fastapi
uvicorn
zarr
numpy
scikit-learn
joblib
```

### 5.2 Startup caching (critical for performance)

All zarr stores, land masks, and sklearn models are loaded once at startup:

```python
_store_cache: dict = {}   # scenario_id → zarr.Group
_land_cache:  dict = {}   # scenario_id → np.ndarray (lat, lon)
_iso_forest_cache: dict = {}  # model_key → IsolationForest
```

**Never re-open zarr or re-load joblib on a per-request basis.**

### 5.3 Endpoints

| Method | Path | Params | Returns |
|---|---|---|---|
| GET | `/scenarios` | — | list of scenario metadata dicts |
| GET | `/state` | `scenario, t` | eta, u, v, E_k, E_p at timestep t |
| GET | `/land` | `scenario` | chi mask (lat, lon) — call once per scenario |
| GET | `/anomaly` | `scenario, t, window=20` | threshold_mask, z_scores, isolation_scores, composite_mask, energy_spike, anomaly_count |

### 5.4 Full main.py

```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import zarr, json, os, numpy as np, joblib

app = FastAPI(title="Ocean Simulator API")
app.add_middleware(CORSMiddleware,
    allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

_store_cache: dict = {}
_land_cache:  dict = {}
_iso_forest_cache: dict = {}

@app.on_event("startup")
def preload():
    for name in os.listdir('data/'):
        if not os.path.isdir(f'data/{name}'): continue
        s = zarr.open(f'data/{name}/', mode='r')
        _store_cache[name] = s
        _land_cache[name]  = np.array(s['chi'])
    for f in os.listdir('models/'):
        if f.endswith('.joblib'):
            _iso_forest_cache[f[:-7]] = joblib.load(f'models/{f}')
    print(f"Loaded {len(_store_cache)} scenarios, {len(_iso_forest_cache)} models")

@app.get("/scenarios")
def list_scenarios():
    out = []
    for name in _store_cache:
        meta = json.load(open(f'data/{name}/metadata.json'))
        out.append({"id": name, **meta})
    return out

@app.get("/state")
def get_state(scenario: str, t: int):
    s = _store_cache[scenario]
    return {
        "scenario": scenario, "t": t,
        "eta": s['eta'][t].tolist(),
        "u":   s['u'][t].tolist(),
        "v":   s['v'][t].tolist(),
        "E_k": float(s['E_k'][t]),
        "E_p": float(s['E_p'][t]),
    }

@app.get("/land")
def get_land(scenario: str):
    """Static land mask — call once per scenario, cache client-side."""
    return {"chi": _land_cache[scenario].tolist()}

@app.get("/anomaly")
def get_anomaly(scenario: str, t: int, window: int = 20):
    from services.anomaly import detect_threshold, detect_isolation, detect_energy_spike
    s       = _store_cache[scenario]
    chi     = _land_cache[scenario]
    t_start = max(0, t - window)
    eta_win = np.array(s['eta'][t_start:t+1])
    u_t     = np.array(s['u'][t])
    v_t     = np.array(s['v'][t])
    E_k_hist = list(s['E_k'][:t+1])

    th_mask, z_scores = detect_threshold(eta_win, k=3.0, wet_mask=(chi < 0.5))
    clf = _iso_forest_cache.get(scenario.split('_')[0])
    iso_scores = detect_isolation(clf, eta_win[-1], u_t, v_t, chi < 0.5) if clf else None
    energy = detect_energy_spike(E_k_hist)
    composite = th_mask
    if iso_scores is not None:
        composite = composite | (iso_scores < -0.15)

    return {
        "threshold_mask":   th_mask.tolist(),
        "z_scores":         z_scores.tolist(),
        "isolation_scores": iso_scores.tolist() if iso_scores is not None else [],
        "composite_mask":   composite.tolist(),
        "energy_spike":     energy,
        "anomaly_count":    int(composite.sum()),
    }
```

---

## 6. DS Module — Anomaly Detection

Three independent layers. Always apply wet mask (`chi < 0.5`) before flagging.

### 6.1 Layer 1: Statistical threshold (z-score)

```python
def detect_threshold(
    eta_window: np.ndarray,   # shape: (W, lat, lon)
    k: float = 3.0,
    wet_mask: np.ndarray = None  # bool (lat, lon)
) -> tuple[np.ndarray, np.ndarray]:
    mean    = eta_window[:-1].mean(axis=0)
    std     = eta_window[:-1].std(axis=0) + 1e-8
    current = eta_window[-1]
    z       = (current - mean) / std
    anomaly = np.abs(z) > k
    if wet_mask is not None:
        anomaly = anomaly & wet_mask
        z[~wet_mask] = 0.0
    return anomaly, z
```

Rule of thumb: k=3 → 0.27% false positive rate under normality.

### 6.2 Layer 2: Isolation Forest

Feature vector per ocean cell: `[η, u, v, speed]`.
Train once on 80% of scenario data, save with joblib, load at startup.

```python
# Train (run offline, not per-request)
def train_isolation_forest(eta, u, v, wet_mask, contamination=0.02,
                            save_path='models/iso_forest.joblib'):
    T = eta.shape[0]
    speed = np.sqrt(u**2 + v**2)
    mask_3d = np.broadcast_to(wet_mask, eta[:int(0.8*T)].shape)
    idx = np.where(mask_3d)
    X = np.stack([eta[:int(0.8*T)][idx], u[:int(0.8*T)][idx],
                  v[:int(0.8*T)][idx], speed[:int(0.8*T)][idx]], axis=-1)
    clf = IsolationForest(n_estimators=100, contamination=contamination,
                          random_state=42, n_jobs=-1)
    clf.fit(X)
    joblib.dump(clf, save_path)
    return clf

# Inference (per-request, fast)
def detect_isolation(clf, eta_t, u_t, v_t, wet_mask):
    lat, lon = eta_t.shape
    speed = np.sqrt(u_t**2 + v_t**2)
    X = np.stack([eta_t, u_t, v_t, speed], axis=-1).reshape(-1, 4)
    scores = np.zeros(lat * lon)
    wet_idx = wet_mask.ravel()
    scores[wet_idx] = clf.decision_function(X[wet_idx])
    return scores.reshape(lat, lon)
    # More negative = more anomalous. Threshold: < -0.15
```

### 6.3 Layer 3: Energy spike detector

```python
def detect_energy_spike(E_k_series: list, window=10, alpha=3.0) -> dict:
    E = np.asarray(E_k_series, dtype=float)
    if len(E) < window + 2:
        return {"spike": False, "severity": 0.0}
    deltas = np.abs(np.diff(E))
    current = deltas[-1]
    baseline_mean = deltas[-window-1:-1].mean() + 1e-12
    severity = current / baseline_mean
    return {"spike": bool(severity > alpha), "severity": float(severity),
            "delta": float(current), "baseline": float(baseline_mean)}
```

---

## 7. Frontend — React + TypeScript

### 7.1 Tech stack

```
Node 20+
React 18 + TypeScript
Vite
cesium + @cesium/engine
deck.gl + @deck.gl/layers + @deck.gl/extensions
plotly.js + react-plotly.js
lodash + @types/lodash
```

### 7.2 Installation

```bash
npm create vite@latest frontend -- --template react-ts
cd frontend
npm install cesium @cesium/engine
npm install deck.gl @deck.gl/layers @deck.gl/extensions
npm install plotly.js react-plotly.js
npm install lodash @types/lodash
```

### 7.3 Globe setup (Globe.tsx)

```tsx
import { useEffect, useRef } from 'react'
import * as Cesium from 'cesium'

export function Globe() {
  const cesiumRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const viewer = new Cesium.Viewer(cesiumRef.current!, {
      terrainProvider:      new Cesium.EllipsoidTerrainProvider(),
      baseLayerPicker:      false,
      navigationHelpButton: false,
      animation:            false,
      timeline:             false,
      geocoder:             false,
    })
    viewer.imageryLayers.removeAll()
    viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#050d1a')
    return () => viewer.destroy()
  }, [])

  return <div ref={cesiumRef} style={{ width: '100%', height: '100vh' }} />
}
```

### 7.4 Texture helpers (utils/textures.ts)

```typescript
// eta → RGBA: blue (neg) → white (0) → red (pos), grey for land
export function etaToTexture(
  eta: number[][], chi: number[][],
  vmin = -2, vmax = 2
): ImageData {
  const lat = eta.length, lon = eta[0].length
  const buf = new Uint8ClampedArray(lat * lon * 4)
  for (let i = 0; i < lat; i++) {
    for (let j = 0; j < lon; j++) {
      const idx = (i * lon + j) * 4
      if (chi[i][j] > 0.5) {
        buf[idx] = 120; buf[idx+1] = 100; buf[idx+2] = 80; buf[idx+3] = 220
        continue
      }
      const t = Math.max(0, Math.min(1, (eta[i][j] - vmin) / (vmax - vmin)))
      buf[idx]   = Math.round(Math.min(255, t * 2 * 255))
      buf[idx+1] = Math.round(Math.max(0, (1 - Math.abs(t - 0.5) * 2) * 200))
      buf[idx+2] = Math.round(Math.max(0, (1 - t) * 2 * 255))
      buf[idx+3] = 190
    }
  }
  return new ImageData(buf, lon, lat)
}

// anomaly mask → red overlay, transparent where no anomaly or land
export function anomalyToTexture(
  mask: boolean[][], scores: number[][], chi: number[][]
): ImageData {
  const lat = mask.length, lon = mask[0].length
  const buf = new Uint8ClampedArray(lat * lon * 4)
  for (let i = 0; i < lat; i++) {
    for (let j = 0; j < lon; j++) {
      const idx = (i * lon + j) * 4
      if (chi[i][j] > 0.5 || !mask[i][j]) continue
      const intensity = Math.min(1, Math.abs(scores[i][j]) / 5)
      buf[idx] = 220; buf[idx+1] = Math.round(40*(1-intensity))
      buf[idx+2] = 40; buf[idx+3] = Math.round(200*intensity)
    }
  }
  return new ImageData(buf, lon, lat)
}
```

### 7.5 State hook (hooks/useOceanState.ts)

```typescript
import { useState, useEffect, useCallback } from 'react'
import { throttle } from 'lodash'

export interface OceanState {
  scenario: string; t: number
  eta: number[][]; u: number[][]; v: number[][]
  E_k: number; E_p: number
}

export function useOceanState(scenario: string, t: number) {
  const [state, setState]     = useState<OceanState | null>(null)
  const [loading, setLoading] = useState(false)

  const fetch_ = useCallback(
    throttle(async (sc: string, ts: number) => {
      setLoading(true)
      const data = await fetch(`/api/state?scenario=${sc}&t=${ts}`).then(r => r.json())
      setState(data)
      setLoading(false)
    }, 100),  // max 10 req/s
    []
  )

  useEffect(() => { fetch_(scenario, t) }, [scenario, t])
  return { state, loading }
}
```

### 7.6 Control panel sliders

Four sliders. Omega is new in v2:

| Slider | Range | Default |
|---|---|---|
| Moon distance | 0.5× – 3× Earth-Moon (192k–1152k km) | 384k km |
| Moon mass | 0 – 3× Moon mass | 1× |
| Rotation Ω | 0.1× – 5× Earth | 1× |
| Temperature | −10°C – +30°C | 15°C |

Nearest-scenario lookup normalises all axes to [0,1] before distance:

```typescript
function nearestScenario(
  scenarios: Scenario[], moonDist: number, omega: number, temp: number
): string {
  const maxDist = 3 * 384000, maxOmega = 5 * 7.292e-5, maxTemp = 40
  return scenarios.reduce((best, s) => {
    const d = Math.hypot(
      (s.moon_dist_km  - moonDist) / maxDist,
      (s.omega_rad_s   - omega)    / maxOmega,
      (s.temperature_C - temp)     / maxTemp
    )
    return d < best.dist ? { id: s.id, dist: d } : best
  }, { id: scenarios[0].id, dist: Infinity }).id
}
```

### 7.7 OmegaBadge component

```tsx
export function OmegaBadge({ omega }: { omega: number }) {
  const rel   = omega / 7.292e-5
  const color = rel > 2 ? '#C0392B' : rel < 0.3 ? '#2980B9' : '#27AE60'
  return (
    <div style={{ background: color, color: 'white', borderRadius: 6,
                  padding: '4px 10px', fontSize: 13, fontWeight: 600 }}>
      Ω = {rel.toFixed(1)}× Earth
    </div>
  )
}
```

### 7.8 Energy chart (EnergyChart.tsx)

```tsx
import Plot from 'react-plotly.js'

export function EnergyChart({ E_k, E_p, spikeTimes, omega }: {
  E_k: number[]; E_p: number[]; spikeTimes: number[]; omega: number
}) {
  const t = E_k.map((_, i) => i)
  return (
    <Plot
      data={[
        { x: t, y: E_k, name: 'E_kinetic',   type: 'scatter', line: { color: '#1E8449' } },
        { x: t, y: E_p, name: 'E_potential',  type: 'scatter', line: { color: '#2E86C1' } },
        { x: spikeTimes, y: spikeTimes.map(() => Math.max(...E_k)),
          name: 'Spikes', mode: 'markers', marker: { color: 'red', size: 10, symbol: 'x' } }
      ]}
      layout={{
        title: `System Energy (wet area) | Ω = ${(omega/7.292e-5).toFixed(1)}×`,
        xaxis: { title: 'Timestep' }, yaxis: { title: 'Energy (J)' },
        margin: { l: 55, r: 10, t: 45, b: 40 }, height: 220,
      }}
      style={{ width: '100%' }}
    />
  )
}
```

---

## 8. Performance Targets

| Operation | Target | How |
|---|---|---|
| `GET /state` | < 50 ms | zarr chunked `(1, lat, lon)` |
| `GET /land` | < 200 ms (once) | loaded at startup |
| Threshold detector | < 10 ms | numpy vectorised |
| Isolation Forest inference | < 50 ms | cached model, wet-only subset |
| Heatmap texture update | < 16 ms | `ImageData` on canvas |
| Globe frame rate | 30+ fps | Cesium GPU renderer |

---

## 9. Physics Validation Targets (reference)

The physics developer validates against these before handing zarr to Vlad:

| Test | Expected |
|---|---|
| Kelvin wave speed | c = √(gH₀) ≈ 198 m/s, error < 1% at 128×64 |
| Equilibrium tide (v2) | η₀ ≈ **0.36 m** (NOT 0.27 m) |
| Energy conservation | E_total drift < 0.1% over 100 steps (wet area) |
| Rossby propagation | Mid-latitude vortex drifts westward ~βk⁻² |
| Land reflection | Incident wave bounces off hill, no global Gibbs ringing |

---

## 10. Key Decisions and Rationale

| Decision | Rationale |
|---|---|
| Dedalus v3 over custom C++ | Weeks to MVP vs months; soft coastlines acceptable for slider-driven visualisation |
| Volume penalization (tanh χ) | Hard land masks cause Gibbs oscillations in spectral solver |
| Precomputed scenarios | CFD too slow for real-time; snap to nearest precomputed |
| SphereBasis not S2Basis | Correct Dedalus v3 API (S2Basis was v1 error) |
| RK443 IMEX, not explicit RK4 | Handles stiffness from gravity-wave and hyperdiffusion terms |
| Full sphere not beta-plane | v2 upgrade: user can drag planet to equator; beta-plane breaks there |
| Zarr chunk (1, lat, lon) | O(1) single-timestep reads for FastAPI |
| Land mask cached at startup | chi is static; no need to re-read per request |
| Wet-mask in anomaly detection | Land cells always flagged as anomalous otherwise (trivially high z-score) |

---

## 11. Known Issues / TODOs

- [ ] `chi.zarr` coordinate order needs explicit confirmation from physics developer before frontend integration
- [ ] Isolation Forest training script not yet written (offline, run before deploy)
- [ ] CesiumJS CORS token for production deploy (currently dev key)
- [ ] Scenario naming convention not finalised (`moon384km_omega1x_temp15` proposed)
- [ ] Physics spec v1 had incorrect tidal force (×2 error) — v2 corrected; old zarr files (if any) must be regenerated
- [ ] Temperature slider currently optional — SST module not in physics v2

---

## 12. Symbol Reference

| Symbol | Meaning |
|---|---|
| `η` | Surface elevation / wave height (m) |
| `u, v` | Zonal, meridional velocity (m/s) |
| `H` | Total water column depth: H₀ + η − H_b |
| `H₀` | Mean ocean depth = 4000 m |
| `H_b` | Bottom topography (m) |
| `χ` | Land mask: 0 = ocean, 1 = land |
| `f(φ)` | Coriolis parameter = 2Ω·sin(φ) |
| `Ω` | Planetary rotation rate (rad/s); Earth = 7.292×10⁻⁵ |
| `c` | Gravity wave speed = √(gH) ≈ 198 m/s |
| `L_R` | Rossby deformation radius = c/\|f\| |
| `E_k, E_p` | Kinetic, potential energy (J), wet-area integral |
| `W` | Anomaly sliding window (default 20 steps) |
| `k` | Z-score threshold (default 3.0σ) |
| `α` | Energy spike ratio (default 3.0) |

---

## 13. Development Workflow

### Starting backend

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

### Starting frontend

```bash
cd frontend
npm install
npm run dev   # proxies /api → localhost:8000
```

### Generating test zarr (without physics solver)

```python
# Run this to create a fake scenario for frontend development
# while waiting for friend's real data
import zarr, json, numpy as np

T, lat, lon = 100, 64, 128
name = 'scenario_test_moon384km_omega1x_temp15'
store = zarr.open(f'backend/data/{name}/', mode='w')

# Fake tidal wave
t_axis = np.linspace(0, 2*np.pi, T)
lat_ax = np.linspace(-np.pi/2, np.pi/2, lat)
lon_ax = np.linspace(-np.pi, np.pi, lon)
LON, LAT = np.meshgrid(lon_ax, lat_ax)

eta = np.array([0.3 * np.cos(t + LON) * np.cos(LAT) for t in t_axis], dtype='float32')
u   = np.array([-0.1 * np.sin(t + LON) for t in t_axis], dtype='float32')
v   = np.zeros_like(u)
chi = np.zeros((lat, lon), dtype='float32')
E_k = np.array([float(np.sum(0.5 * 1025 * 4000 * (u[i]**2 + v[i]**2))) for i in range(T)], dtype='float32')
E_p = np.array([float(np.sum(0.5 * 1025 * 9.81 * eta[i]**2)) for i in range(T)], dtype='float32')

store.create_dataset('eta', data=eta, chunks=(1,lat,lon))
store.create_dataset('u',   data=u,   chunks=(1,lat,lon))
store.create_dataset('v',   data=v,   chunks=(1,lat,lon))
store.create_dataset('chi', data=chi)
store.create_dataset('E_k', data=E_k)
store.create_dataset('E_p', data=E_p)

json.dump({
    "moon_dist_km": 384000, "moon_mass_rel": 1.0,
    "omega_rad_s": 7.292e-5, "temperature_C": 15.0,
    "grid_shape": [lat, lon], "dt_seconds": 1800,
    "T_total_steps": T, "lat_range": [-90, 90], "lon_range": [-180, 180]
}, open(f'backend/data/{name}/metadata.json', 'w'))
print("Test scenario written.")
```

---

## 14. Build Plan

> **How to use this section:**  
> Work phase by phase, top to bottom. Do not start a phase until the previous one is ✅.  
> Each task has an owner: **[V]** = Vlad, **[K]** = Kirill (physics), **[both]** = coordinate together.

---

### Phase 0 — Setup (Week 1, Days 1–2)

Goal: both developers can run something locally.

- [ ] **[both]** Create GitHub repo `planetary-ocean-simulator`, add this CLAUDE.md, agree on branch strategy (`main` protected, feature branches `feat/BE-*`, `feat/FE-*`, `feat/PHY-*`)
- [ ] **[V]** Scaffold `backend/` — FastAPI app, empty routers, requirements.txt, `uvicorn main:app --reload` runs without errors
- [ ] **[V]** Scaffold `frontend/` — Vite + React + TS, install all deps from Section 7.2, `npm run dev` shows blank page without errors
- [ ] **[V]** Run fake zarr generator (Section 13) → `backend/data/scenario_test_*/` exists
- [ ] **[V]** Implement `GET /scenarios` and `GET /state` reading from fake zarr → returns JSON in browser
- [ ] **[K]** Dedalus v3 install confirmed, `import dedalus.public as d3` works
- [ ] **[K]** SWE running on flat periodic domain (no sphere yet), zarr output matches schema in Section 4

**Phase 0 done when:** `curl localhost:8000/state?scenario=scenario_test_moon384km_omega1x_temp15&t=0` returns eta array, and Kirill has Dedalus producing zarr.

---

### Phase 1 — Globe + Basic Heatmap (Week 1–2)

Goal: you can see the ocean on the globe.

- [ ] **[V]** `Globe.tsx` renders CesiumJS viewer, dark background, no default imagery
- [ ] **[V]** Fetch `GET /state` at t=0, render `etaToTexture()` as `BitmapLayer` on globe — blue/white/red heatmap visible
- [ ] **[V]** Fetch `GET /land` once, render `chi` as grey terrain overlay — for now chi=0 everywhere (no land), overlay invisible
- [ ] **[V]** Basic layout: globe fills screen, placeholder sidebar div on the right
- [ ] **[K]** Sphere geometry working in Dedalus (`SphereBasis`), SWE runs 100 steps without diverging
- [ ] **[K]** β-plane Coriolis → full-sphere `f(φ) = 2Ω·sin(φ)` via `MulCosine(skew(u))` idiom

**Phase 1 done when:** heatmap renders on globe from fake data, Kirill has sphere SWE stable.

---

### Phase 2 — Timeline + Controls (Week 3–4)

Goal: user can play the simulation and move sliders.

- [ ] **[V]** Timeline slider at bottom (t: 0 → T_total_steps), auto-play button
- [ ] **[V]** `useOceanState` hook with 100ms throttle — heatmap updates as slider moves
- [ ] **[V]** Loading indicator during fetch
- [ ] **[V]** Control panel: 4 sliders (moon distance, moon mass, Ω, temperature)
- [ ] **[V]** `nearestScenario()` logic — on slider change, pick closest precomputed scenario and reload
- [ ] **[V]** `OmegaBadge` component showing current Ω relative to Earth
- [ ] **[V]** `GET /scenarios` endpoint returns list — frontend populates scenario picker
- [ ] **[K]** Variable bottom topography `H_b(λ,φ)` working — ridges reduce wave height above them
- [ ] **[K]** Tidal forcing from single moon — `U_tidal` computed from moon position, η shows tidal bulge
- [ ] **[K]** First real scenario precomputed and saved as zarr — hand off to Vlad

**Phase 2 done when:** slider moves → scenario switches → heatmap changes. Kirill hands first real zarr.

---

### Phase 3 — Real Data + Anomaly Layer 1 (Week 5–6)

Goal: real physics data visible, first anomaly detector live.

- [ ] **[V]** Replace fake zarr with Kirill's first real scenario — verify coordinate convention matches (Section 4.4)
- [ ] **[V]** Velocity vector layer — `buildVectorPoints()` renders arrows on ocean cells, skips land
- [ ] **[V]** Implement `detect_threshold()` in `services/anomaly.py` with wet mask
- [ ] **[V]** `GET /anomaly` endpoint wired up
- [ ] **[V]** `anomalyToTexture()` renders red overlay on anomalous cells
- [ ] **[V]** Plotly `EnergyChart` in sidebar — E_k and E_p time series, spike markers
- [ ] **[V]** Layer 3 `detect_energy_spike()` wired to chart — red X markers on spikes
- [ ] **[K]** Volume penalization land mask `χ` working — hills above sea level reflect water
- [ ] **[K]** `chi.zarr` included in output — Vlad can render terrain
- [ ] **[K]** Ω slider support — precompute 3+ scenarios at different rotation rates

**Phase 3 done when:** real waves visible, red anomaly overlay appears, energy chart shows spikes.

---

### Phase 4 — Isolation Forest + Polish (Week 7–8)

Goal: full DS module, project looks like a product.

- [ ] **[V]** Write offline training script `scripts/train_iso_forest.py` — reads zarr, trains on 80%, saves joblib
- [ ] **[V]** Train Isolation Forest on Kirill's real scenarios, save to `backend/models/`
- [ ] **[V]** Wire `detect_isolation()` into `/anomaly` endpoint
- [ ] **[V]** Composite anomaly overlay (threshold OR isolation forest)
- [ ] **[V]** Anomaly count badge in sidebar ("12 anomalous cells")
- [ ] **[V]** Scenario library UI — grid of cards showing precomputed scenarios with thumbnails
- [ ] **[V]** README.md written, project deployable on Railway
- [ ] **[K]** Multiple moons support — superpose tidal potentials
- [ ] **[K]** 20+ precomputed scenarios covering full slider range
- [ ] **[K]** Energy conservation validation passing (< 0.1% drift)
- [ ] **[K]** Land reflection validation — no global Gibbs ringing

**Phase 4 done when:** full demo runnable, anomaly detection working on real data, deployed.

---

### Buffer — Stretch Goals (if time allows)

- [ ] **[V]** WebGL water shader for realistic ocean surface
- [ ] **[V]** Mobile layout
- [ ] **[K]** SST (sea surface temperature) module — thermal layer
- [ ] **[K]** High-res 256×128 offline scenarios
- [ ] **[both]** Live drawing of topography — user sculpts seabed in real time

---

### Dependency Graph

```
Phase 0 (setup)
    │
    ├── [V] Phase 1 (globe)          [K] Phase 1 (sphere SWE)
    │         │                               │
    ├── [V] Phase 2 (timeline/sliders)  [K] Phase 2 (tidal, zarr handoff)
    │         │                               │
    │         └──────────── real zarr ────────┘
    │                           │
    ├── [V] Phase 3 (real data + anomaly L1+L3)
    │         │
    └── [V] Phase 4 (isolation forest + polish)
```

**Critical path:** Kirill must hand off first real zarr by end of Phase 2 (Week 4).  
Everything after that unblocks on that zarr file.

---

*CLAUDE.md — Planetary Ocean Simulator. Physics spec v2. Last updated: June 2026.*
