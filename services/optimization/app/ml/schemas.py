"""Request/response bodies for app/ml/routes.py. Every response model carries `prototype: True` and
`trained_on: "synthetic_data"` as REQUIRED (non-optional) fields, not something a caller could
accidentally omit - see this package's own __init__.py for why that matters.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class PredictionRequest(BaseModel):
    distance_km: float = Field(gt=0, le=200)
    hour_of_day: int = Field(ge=0, le=23)
    day_of_week: int = Field(ge=0, le=6, description="Monday=0 .. Sunday=6")
    naive_duration_seconds: float = Field(
        gt=0,
        description=(
            "The deterministic, no-traffic estimate - what calculateRoute's own real duration "
            "would be."
        ),
    )


class EtaPredictionResponse(BaseModel):
    predicted_duration_seconds: float
    prototype: Literal[True] = True
    trained_on: Literal["synthetic_data"] = "synthetic_data"


class CancellationPredictionResponse(BaseModel):
    cancellation_risk: float
    prototype: Literal[True] = True
    trained_on: Literal["synthetic_data"] = "synthetic_data"


class MlStatusResponse(BaseModel):
    prototype: Literal[True] = True
    trained_on: Literal["synthetic_data"] = "synthetic_data"
    trained_at: str
    trained_row_count: int
    data_source: str
    eta_validation_mean_absolute_error_seconds: float
    cancellation_validation_auc: float
    warning: str = (
        "This is a prototype trained and validated on SYNTHETIC data only - it has never seen a "
        "real trip and is not production-ready. It does not influence any real matching, "
        "payment or notification decision."
    )
