"""The /ml/* endpoints (Phase 13, modules "ETA model" and "Cancellation prediction" - Demand
prediction, Route compatibility prediction and Network forecasting are all deliberately out of scope
for this pass, user-approved).

THE HARD BOUNDARY (spec section 32, "AI vs Optimization... mandatory"): AI/ML is for prediction
only; optimization algorithms (module 6, this same service's own /candidates and /optimize) are
for decisions. Nothing in this file is called from anywhere else in this service, or from any
Cloud Function - main.py only mounts this router so the admin dashboard's own "AI Predictions"
page (apps/admin) can call it directly, the one and only caller. No matching, payment or
notification decision reads a response from here, and none should ever be changed to.

Every model is trained on SYNTHETIC data only (app/ml/__init__.py) - every response below says so.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.ml.cancellation_model import predict_cancellation_risk
from app.ml.eta_model import predict_eta_seconds
from app.ml.features import features_from_request
from app.ml.registry import registry
from app.ml.schemas import (
    CancellationPredictionResponse,
    EtaPredictionResponse,
    MlStatusResponse,
    PredictionRequest,
)

router = APIRouter(prefix="/ml", tags=["ml-prototype"])


@router.get("/status")
def status() -> MlStatusResponse:
    trained = registry.get()
    return MlStatusResponse(
        trained_at=trained.trained_at.isoformat(),
        trained_row_count=trained.eta.trained_row_count,
        data_source=trained.data_source_description,
        eta_validation_mean_absolute_error_seconds=trained.eta.validation_mean_absolute_error_seconds,
        cancellation_validation_auc=trained.cancellation.validation_auc,
    )


@router.post("/eta/predict")
def predict_eta(body: PredictionRequest) -> EtaPredictionResponse:
    trained = registry.get()
    features = features_from_request(
        distance_km=body.distance_km,
        hour_of_day=body.hour_of_day,
        day_of_week=body.day_of_week,
        naive_duration_seconds=body.naive_duration_seconds,
    )
    seconds = predict_eta_seconds(trained.eta.model, features)
    return EtaPredictionResponse(predicted_duration_seconds=seconds)


@router.post("/cancellation/predict")
def predict_cancellation(body: PredictionRequest) -> CancellationPredictionResponse:
    trained = registry.get()
    features = features_from_request(
        distance_km=body.distance_km,
        hour_of_day=body.hour_of_day,
        day_of_week=body.day_of_week,
        naive_duration_seconds=body.naive_duration_seconds,
    )
    risk = predict_cancellation_risk(trained.cancellation.model, features)
    return CancellationPredictionResponse(cancellation_risk=risk)
