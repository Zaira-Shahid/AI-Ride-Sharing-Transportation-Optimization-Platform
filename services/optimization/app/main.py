"""The optimization service's HTTP app (Module 6.0, foundation).

Runs on Cloud Run, next to (not part of) the Firebase project: Cloud Functions call it over HTTPS
the way they already call OSRM and Nominatim (functions/src/routing.ts, geocoding.ts), rather than
running OR-Tools in the Functions process itself. Nothing about matching lives here yet - Module 6.1
onwards adds the real endpoints; this module only proves the service exists, starts and answers.
"""

from fastapi import FastAPI

app = FastAPI(title="RideMesh Optimization Service")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "ridemesh-optimization"}
