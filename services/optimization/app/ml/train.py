"""Standalone CLI entrypoint that trains both prototype models and prints their own validation
metrics - demonstrates the pipeline (synthetic_data.py -> features.py -> eta_model.py/
cancellation_model.py) runs on its own, independent of registry.py's lazy, in-process caching, and
independent of the FastAPI app in main.py. Useful for a quick manual sanity check after changing
the synthetic data methodology or either model. Run as: `python -m app.ml.train`.
"""

from __future__ import annotations

import time

from app.ml.cancellation_model import train_cancellation_model
from app.ml.eta_model import train_eta_model
from app.ml.synthetic_data import SyntheticDataConfig, SyntheticTripDataSource


def main() -> None:
    config = SyntheticDataConfig()
    data_source = SyntheticTripDataSource(config)

    print("PROTOTYPE training run - synthetic data only (see app/ml/__init__.py)")
    print(
        f"Config: {config.trip_count} trips, {config.history_days} days, seed={config.random_seed}"
    )

    started_at = time.perf_counter()
    eta_result = train_eta_model(data_source)
    cancellation_result = train_cancellation_model(data_source)
    elapsed_seconds = time.perf_counter() - started_at

    print(f"\nTrained {eta_result.trained_row_count} rows in {elapsed_seconds:.2f}s")
    print(
        f"ETA model validation MAE: {eta_result.validation_mean_absolute_error_seconds:.1f} seconds"
    )
    print(f"Cancellation model validation AUC: {cancellation_result.validation_auc:.3f}")


if __name__ == "__main__":
    main()
