from pathlib import Path
from typing import Any, Dict, List
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import pandas as pd

app = FastAPI(
    title="FoveaGrid API",
    description="AgniVeda SIH FoveaGrid 2.5D Elevation Mapping API",
    version="1.0.0",
)

# Enable CORS (Cross-Origin Resource Sharing)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Path to the 2.5D map CSV file
BASE_DIR = Path(__file__).resolve().parent.parent
CSV_PATH = BASE_DIR / "data" / "foveagrid_25d_map.csv"


def get_data_filepath() -> Path:
    """Resolve the path to foveagrid_25d_map.csv robustly."""
    if CSV_PATH.exists():
        return CSV_PATH
    for candidate in [
        Path("backend/data/foveagrid_25d_map.csv"),
        Path("data/foveagrid_25d_map.csv"),
    ]:
        if candidate.exists():
            return candidate.resolve()
    return CSV_PATH


@app.get("/")
def root():
    return {
        "message": "FoveaGrid Backend API is running",
        "endpoints": {
            "telemetry": "/api/telemetry",
            "map_data": "/api/map-data",
        },
    }


@app.get("/api/telemetry")
def get_telemetry() -> Dict[str, Any]:
    """
    Returns the AgniVeda SIH metrics:
    - FPS: 16.2
    - latency_ms: 58.0
    - memory_gb: 0.9
    - total_cells: '0.48 M'
    """
    return {
        "fps": 16.2,
        "FPS": 16.2,
        "latency_ms": 58.0,
        "memory_gb": 0.9,
        "total_cells": "0.48 M",
    }


@app.get("/api/map-data")
def get_map_data() -> List[Dict[str, Any]]:
    """
    Reads backend/data/foveagrid_25d_map.csv and returns the first 1000 cells as JSON.
    """
    file_path = get_data_filepath()
    if not file_path.exists():
        raise HTTPException(
            status_code=404,
            detail=f"Map data CSV file not found at {file_path}",
        )

    df = pd.read_csv(file_path)
    # Extract the first 1000 cells and convert to records list
    cells = df.head(1000).to_dict(orient="records")
    return cells
