"""PROTOTYPE - trained on synthetic data only (app/ml/__init__.py). Predicts a trip's own actual
duration (seconds), given the same naive distance/speed estimate calculateRoute would produce plus
time-of-day/day-of-week - i.e., it tries to learn the synthetic "traffic" effect
synthetic_data.py's own generator invented, not a real one. Never call this for a real ETA shown
to a passenger or driver (app/ml/routes.py's own header comment names the hard boundary).
"""

from __future__ import annotations

from dataclasses import dataclass

import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.metrics import mean_absolute_error
from sklearn.model_selection import train_test_split

from app.ml.features import features_from_frame
from app.ml.synthetic_data import TripDataSource

RANDOM_STATE = 20260101


@dataclass(frozen=True)
class EtaModelResult:
    model: GradientBoostingRegressor
    validation_mean_absolute_error_seconds: float
    trained_row_count: int


def train_eta_model(data_source: TripDataSource) -> EtaModelResult:
    data = data_source.load_trips()
    features = features_from_frame(data)
    target = data["actual_duration_seconds"]

    features_train, features_valid, target_train, target_valid = train_test_split(
        features, target, test_size=0.2, random_state=RANDOM_STATE
    )

    model = GradientBoostingRegressor(random_state=RANDOM_STATE)
    model.fit(features_train, target_train)

    predicted = model.predict(features_valid)
    mae = float(mean_absolute_error(target_valid, predicted))

    return EtaModelResult(
        model=model,
        validation_mean_absolute_error_seconds=mae,
        trained_row_count=len(data),
    )


def predict_eta_seconds(model: GradientBoostingRegressor, features: pd.DataFrame) -> float:
    return float(model.predict(features)[0])
