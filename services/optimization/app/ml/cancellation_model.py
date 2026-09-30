"""PROTOTYPE - trained on synthetic data only (app/ml/__init__.py). Estimates a trip's own
cancellation risk (spec section 31: "Estimate cancellation risk"), given the same features as the
ETA model. Learns synthetic_data.py's own invented cancellation rule, not a real one. Never call
this for a real decision about a real trip (app/ml/routes.py's own header comment names the hard
boundary).
"""

from __future__ import annotations

from dataclasses import dataclass

import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import train_test_split

from app.ml.features import features_from_frame
from app.ml.synthetic_data import TripDataSource

RANDOM_STATE = 20260101


@dataclass(frozen=True)
class CancellationModelResult:
    model: RandomForestClassifier
    validation_auc: float
    trained_row_count: int


def train_cancellation_model(data_source: TripDataSource) -> CancellationModelResult:
    data = data_source.load_trips()
    features = features_from_frame(data)
    target = data["cancelled"]

    features_train, features_valid, target_train, target_valid = train_test_split(
        features, target, test_size=0.2, random_state=RANDOM_STATE, stratify=target
    )

    model = RandomForestClassifier(
        n_estimators=200, max_depth=6, random_state=RANDOM_STATE, class_weight="balanced"
    )
    model.fit(features_train, target_train)

    predicted_probability = model.predict_proba(features_valid)[:, 1]
    auc = float(roc_auc_score(target_valid, predicted_probability))

    return CancellationModelResult(
        model=model,
        validation_auc=auc,
        trained_row_count=len(data),
    )


def predict_cancellation_risk(model: RandomForestClassifier, features: pd.DataFrame) -> float:
    return float(model.predict_proba(features)[:, 1][0])
