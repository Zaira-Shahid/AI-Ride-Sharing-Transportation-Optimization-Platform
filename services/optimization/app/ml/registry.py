"""Trains both prototype models ONCE per process and caches them in memory - no persisted model
file, nothing to version or deploy separately (a deliberate choice for a prototype this small:
~10,000 rows trains in well under two seconds, see app/ml/train.py's own timing). Training happens
lazily, on the first call that needs a model, not at import time.

Swapping in real data later means swapping the `TripDataSource` passed in here (see
synthetic_data.py's own header comment on the protocol) - nothing else in this file, or in
eta_model.py/cancellation_model.py, needs to change.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from datetime import UTC, datetime

from app.ml.cancellation_model import CancellationModelResult, train_cancellation_model
from app.ml.eta_model import EtaModelResult, train_eta_model
from app.ml.synthetic_data import SyntheticDataConfig, SyntheticTripDataSource, TripDataSource


@dataclass(frozen=True)
class TrainedModels:
    eta: EtaModelResult
    cancellation: CancellationModelResult
    trained_at: datetime
    data_source_description: str


class ModelRegistry:
    def __init__(self, data_source: TripDataSource | None = None) -> None:
        self._data_source = data_source or SyntheticTripDataSource(SyntheticDataConfig())
        self._lock = threading.Lock()
        self._trained: TrainedModels | None = None

    def get(self) -> TrainedModels:
        if self._trained is not None:
            return self._trained
        with self._lock:
            if self._trained is None:
                self._trained = TrainedModels(
                    eta=train_eta_model(self._data_source),
                    cancellation=train_cancellation_model(self._data_source),
                    trained_at=datetime.now(tz=UTC),
                    data_source_description=type(self._data_source).__name__,
                )
            return self._trained


# One shared registry for the whole process - the same "construct once, reuse" shape the
# optimization service's own app-level objects already use (e.g. the FastAPI `app` itself in
# main.py).
registry = ModelRegistry()
