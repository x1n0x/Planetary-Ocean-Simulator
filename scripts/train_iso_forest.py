"""Offline training for the Isolation Forest anomaly detector (CLAUDE.md §6.2).

Reads every scenario in ``backend/data/``, builds the per-wet-cell feature
vector ``[eta, u, v, speed]`` from the first 80% of timesteps, and fits a single
shared IsolationForest. The model is saved to ``backend/models/scenario.joblib``.

Why one shared model: the ``/anomaly`` router looks the model up by
``scenario.split("_")[0]`` — which is the literal ``"scenario"`` for every
store — so all scenarios resolve to the same key. Training on the pooled data of
all scenarios also yields a more robust detector than one tiny per-scenario fit.

Run from the repo root:
    python scripts/train_iso_forest.py
"""
from __future__ import annotations

import argparse
import os

import joblib
import numpy as np
import zarr
from sklearn.ensemble import IsolationForest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(REPO_ROOT, "backend", "data")
MODELS_DIR = os.path.join(REPO_ROOT, "backend", "models")

TRAIN_FRACTION = 0.8
WET_THRESHOLD = 0.5  # chi < 0.5 -> ocean


def build_features(scenario_dir: str) -> np.ndarray:
    """Stack [eta, u, v, speed] over wet cells of the first 80% of frames."""
    store = zarr.open(scenario_dir, mode="r")
    chi = np.asarray(store["chi"])
    wet = chi < WET_THRESHOLD

    T = store["eta"].shape[0]
    t_end = max(1, int(TRAIN_FRACTION * T))

    eta = np.asarray(store["eta"][:t_end])
    u = np.asarray(store["u"][:t_end])
    v = np.asarray(store["v"][:t_end])
    speed = np.sqrt(u**2 + v**2)

    # broadcast the static (lat, lon) wet mask across the time axis
    mask_3d = np.broadcast_to(wet, eta.shape)
    idx = np.where(mask_3d)
    X = np.stack([eta[idx], u[idx], v[idx], speed[idx]], axis=-1)
    return X.astype(np.float32)


def main() -> None:
    parser = argparse.ArgumentParser(description="Train the Isolation Forest detector.")
    parser.add_argument("--contamination", type=float, default=0.02)
    parser.add_argument("--n-estimators", type=int, default=100)
    parser.add_argument("--out", default=os.path.join(MODELS_DIR, "scenario.joblib"))
    args = parser.parse_args()

    if not os.path.isdir(DATA_DIR):
        raise SystemExit(f"No data directory at {DATA_DIR}")

    scenarios = sorted(
        name
        for name in os.listdir(DATA_DIR)
        if os.path.isdir(os.path.join(DATA_DIR, name))
    )
    if not scenarios:
        raise SystemExit(f"No scenarios found in {DATA_DIR}")

    feature_blocks = []
    for name in scenarios:
        X = build_features(os.path.join(DATA_DIR, name))
        feature_blocks.append(X)
        print(f"  {name}: {X.shape[0]:>8,} wet-cell samples")

    X_all = np.concatenate(feature_blocks, axis=0)
    print(f"Pooled training matrix: {X_all.shape}")

    clf = IsolationForest(
        n_estimators=args.n_estimators,
        contamination=args.contamination,
        random_state=42,
        n_jobs=-1,
    )
    clf.fit(X_all)

    os.makedirs(MODELS_DIR, exist_ok=True)
    joblib.dump(clf, args.out)
    print(f"Saved model -> {args.out}")


if __name__ == "__main__":
    main()
