"""Turns a trip's own raw fields into the numeric feature vector both models use - shared by
training (synthetic_data.py's own DataFrame) and inference (routes.py's own request bodies), so the
two can never quietly drift apart (the classic train/serve skew).

Deliberately excludes two of spec section 31's own suggested ETA inputs: weather (the spec's own
line hedges this - "if legally/technically appropriate" - and no weather data or API is integrated
anywhere in this codebase) and road type (nothing in this codebase classifies roads by type
either). Both are a documented omission, not silently dropped.
"""

from __future__ import annotations

import pandas as pd

FEATURE_COLUMNS = ["distance_km", "hour_of_day", "day_of_week", "naive_duration_seconds"]


def features_from_frame(data: pd.DataFrame) -> pd.DataFrame:
    return data[FEATURE_COLUMNS]


def features_from_request(
    distance_km: float,
    hour_of_day: int,
    day_of_week: int,
    naive_duration_seconds: float,
) -> pd.DataFrame:
    return pd.DataFrame(
        [
            {
                "distance_km": distance_km,
                "hour_of_day": hour_of_day,
                "day_of_week": day_of_week,
                "naive_duration_seconds": naive_duration_seconds,
            }
        ]
    )
