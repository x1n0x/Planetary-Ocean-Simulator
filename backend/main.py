"""Ocean Simulator API — FastAPI entrypoint.

Run from the backend/ directory:
    uvicorn main:app --reload --port 8000
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from services import zarr_reader
from routers import scenarios, state, land, anomaly

app = FastAPI(title="Ocean Simulator API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def preload():
    zarr_reader.preload()


@app.get("/health")
def health():
    return {"status": "ok", "scenarios": zarr_reader.scenario_ids()}


app.include_router(scenarios.router)
app.include_router(state.router)
app.include_router(land.router)
app.include_router(anomaly.router)
