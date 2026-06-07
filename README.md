<div align="center">

# 🌊 Planetary Ocean Simulator

**An interactive ocean-world simulator with real fluid dynamics**

*Drag a moon. Sculpt the seabed. Watch the ocean respond.*

[![Physics](https://img.shields.io/badge/physics-Dedalus%20v3%20SWE-2E86C1)](https://dedalus-project.org)
[![Frontend](https://img.shields.io/badge/frontend-React%20%2B%20CesiumJS-117A65)](https://cesium.com)
[![Backend](https://img.shields.io/badge/backend-FastAPI-1A5276)](https://fastapi.tiangolo.com)
[![Status](https://img.shields.io/badge/status-in%20development-orange)]()

</div>

---

## What is Planetary Ocean Simulator?

Planetary Ocean Simulator is a browser-based simulator of a water-covered planet. The physics are real —
rotating shallow water equations on a full sphere, tidal forcing from orbiting moons,
topographic reflection — but the interface is a Google Earth-style globe with four sliders.

Move the moon closer and watch tidal bulges grow. Spin the planet faster and see
zonal jets emerge from the Coriolis force. Raise a seamount and watch waves reflect.
The anomaly detector highlights when the ocean enters an unusual state.

---

## Demo

<img width="1529" height="1050" alt="image" src="https://github.com/user-attachments/assets/321e1058-3d55-4a69-8b1d-f54ce70bd15d" />


---

## Features

- 🌍 **Full-sphere ocean** — rotating shallow water equations on S², no flat-plane approximations
- 🌕 **Live tidal forcing** — drag moon distance and mass, tides respond in real time
- 🌀 **Coriolis dynamics** — scale planetary rotation from 0.1× to 5× Earth, watch jets form
- ⛰️ **Seabed sculpting** — ridges and seamounts reflect waves via volume penalization
- 🔴 **Anomaly detection** — three-layer DS module: z-score threshold, Isolation Forest, energy spike detector
- 📊 **Live analytics** — kinetic + potential energy time series, anomaly count, rotation indicator

---

## Architecture

```
┌─────────────────────────────────────────────┐
│  Browser (React + CesiumJS + deck.gl)        │
│  Globe · Heatmap · Vectors · Controls        │
└──────────────────┬──────────────────────────┘
                   │ REST (JSON)
┌──────────────────▼──────────────────────────┐
│  FastAPI backend                             │
│  /state · /land · /scenarios · /anomaly     │
│  zarr reader · sklearn anomaly models        │
└──────────────────┬──────────────────────────┘
                   │ zarr files
┌──────────────────▼──────────────────────────┐
│  Physics (Dedalus v3, Python)                │
│  Rotating SWE · Tidal forcing · Topography  │
│  Precomputed scenario library                │
└─────────────────────────────────────────────┘
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Physics solver | [Dedalus v3](https://dedalus-project.org) — spectral SWE on S² |
| Backend API | FastAPI + zarr + scikit-learn |
| 3D Globe | CesiumJS + deck.gl BitmapLayer |
| Frontend | React 18 + TypeScript + Vite |
| Anomaly detection | scikit-learn Isolation Forest + numpy |
| Data format | zarr (chunked arrays, O(1) timestep reads) |
| Deploy | Railway |

---

## Getting Started

### Prerequisites

- Python 3.11+
- Node 20+
- Git

### 1. Clone

```bash
git clone https://github.com/youruser/planetary-ocean-simulator.git
cd planetary-ocean-simulator
```

### 2. Backend

```bash
cd backend
pip install -r requirements.txt

# Generate fake test data (no physics solver needed)
python scripts/generate_test_zarr.py

# Start API
uvicorn main:app --reload --port 8000
```

### 3. Frontend

```bash
cd frontend
npm install
npm run dev
# Opens at http://localhost:5173
```

### 4. Verify

```bash
curl "http://localhost:8000/scenarios"
curl "http://localhost:8000/state?scenario=scenario_test_moon384km_omega1x_temp15&t=0"
```

---

## Project Structure

```
planetary-ocean-simulator/
├── CLAUDE.md          # Full context for Claude Code (read this first)
├── README.md          # This file
├── physics/           # Kirill's domain — Dedalus SWE solver
│   ├── simulation.py
│   ├── generate_scenarios.py
│   └── validate.py
├── backend/           # Vlad's FastAPI
│   ├── main.py
│   ├── routers/
│   ├── services/
│   ├── data/          # zarr stores (gitignored)
│   └── models/        # sklearn models (gitignored)
├── frontend/          # Vlad's React app
│   └── src/
│       ├── components/
│       ├── hooks/
│       └── utils/
└── docker-compose.yml
```

---

## Data Contract

The physics module outputs zarr stores consumed by the backend.
Full schema documented in [CLAUDE.md § 4](./CLAUDE.md).

```
scenario_moon384km_omega1x_temp15/
  eta.zarr        # wave height      (T, lat, lon) float32
  u.zarr          # zonal velocity   (T, lat, lon) float32
  v.zarr          # meridional vel   (T, lat, lon) float32
  chi.zarr        # land mask        (lat, lon)    float32
  E_k.zarr        # kinetic energy   (T,)          float32
  E_p.zarr        # potential energy (T,)          float32
  metadata.json
```

---

## Physics

The core model is the **rotating shallow water equations** on a full sphere:

```
∂u/∂t + (u·∇)u + f·k̂×u = −g∇η + ∇U_tidal + F_drag + F_land
∂η/∂t + ∇·(Hu) = 0
f(φ) = 2Ω·sin(φ)          ← full sphere, not beta-plane
```

Solved spectrally with Dedalus v3 (`SphereBasis`, `RK443` IMEX timestepper).
Topographic reflection via volume penalization (tanh land mask `χ`).

Full physics specification: [CLAUDE.md § 3](./CLAUDE.md) and [physics/spec_v2.pdf](./physics/spec_v2.pdf).

---

## Anomaly Detection

Three independent layers stacked into a composite signal:

| Layer | Method | What it catches |
|---|---|---|
| 1 | Rolling z-score per grid cell | Local point anomalies (η > 3σ) |
| 2 | Isolation Forest on [η, u, v, speed] | Multivariate outliers |
| 3 | Energy spike ratio | System-level phase transitions |

Ocean cells only — land mask applied before flagging.

---

## Roadmap

- [x] Physics spec v2 (full sphere, corrected tidal force, volume penalization)
- [x] Zarr data contract agreed
- [x] FastAPI scaffold + fake zarr generator
- [ ] CesiumJS globe with heatmap (Phase 1)
- [ ] Timeline slider + 4-control panel (Phase 2)
- [ ] First real physics zarr from Kirill (Phase 2 end)
- [ ] Anomaly layers 1 + 3 live (Phase 3)
- [ ] Isolation Forest on real data (Phase 4)
- [ ] Deploy on Railway (Phase 4)

Full build plan: [CLAUDE.md § 14](./CLAUDE.md).

---

## Team

| Person | Role |
|---|---|
| **Vlad** | Frontend (React + CesiumJS), backend (FastAPI), data science (anomaly detection) |
| **Kirill** | Physics (Dedalus SWE solver), mathematics (tidal mechanics, Coriolis dynamics) |

---

## Name

*Planetary Ocean Simulator* (Θάλασσα) — goddess of the sea in Greek mythology, and a moon of Neptune.

---

## License

MIT
