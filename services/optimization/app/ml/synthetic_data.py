"""Generates the synthetic trip history the ETA and cancellation prototypes train on.

User-approved methodology (checked with the user before any of this was generated): ~90 days of
history, ~10,000 trips, this codebase's own already-established test city (geography.py), a
documented (not measured) rush-hour-shaped demand curve (timing.py), hotspot-clustered pickups/
dropoffs with jitter, an invented cancellation rule, and a synthetic "traffic" multiplier layered on
top of a deterministic distance/speed estimate - every one of these is a stated assumption, not a
real pattern, and is documented at the point it is used below.

`TripDataSource` is the swappable seam module 13 was asked to keep: `SyntheticTripDataSource` is
the only implementation today, but anything that can return the same DataFrame shape (say, a
`FirestoreTripDataSource` reading real completed trips, once "reliable operational data exists" -
this phase's own spec line) can be swapped in for training without changing eta_model.py/
cancellation_model.py at all, since both only ever depend on this protocol, never on this class.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Protocol

import pandas as pd

from app.ml.geography import (
    BOUNDING_BOX,
    HOTSPOT_JITTER_DEGREES,
    HOTSPOTS,
    RANDOM_LOCATION_SHARE,
    Hotspot,
)
from app.ml.timing import hourly_weights_for

# An urban average, not measured for any real fleet - used only to turn a synthetic distance into
# a plausible "no traffic" duration, the same role calculateRoute's own real, free-flow routing
# plays in production (functions/src/routing.ts's own note: "There is no traffic in the times").
ASSUMED_AVERAGE_SPEED_KMH = 25.0

# The synthetic "traffic" multiplier applied on top of the naive distance/speed duration, by hour of
# day - invented, meant only to give the ETA model something to learn beyond the naive estimate
# alone (see this module's own header comment). >1 means slower than free-flow, <1 faster.
_RUSH_HOURS = {7, 8, 17, 18}
_SHOULDER_HOURS = {6, 9, 16, 19}


def _traffic_multiplier(hour_of_day: int, rng: random.Random) -> float:
    if hour_of_day in _RUSH_HOURS:
        base = 1.6
    elif hour_of_day in _SHOULDER_HOURS:
        base = 1.25
    elif 0 <= hour_of_day <= 4:
        base = 0.85
    else:
        base = 1.0
    return max(0.5, rng.gauss(base, 0.12))


def _cancellation_probability(
    actual_duration_seconds: float, hour_of_day: int, rng: random.Random
) -> float:
    """An invented rule, not a measured one (this module's own header comment): the longer the
    (synthetic, traffic-inflated) predicted ride, the likelier a passenger is made to cancel - a
    plausible real-world shape (a long predicted wait/ride is the clearest reason to give up on
    one), picked deliberately as the DOMINANT term so the prototype model has a real signal to
    find over the per-trip noise, plus a smaller bump for the least sociable hours.
    """
    duration_minutes = actual_duration_seconds / 60
    base = 0.04
    base += min(0.35, (duration_minutes / 90.0) * 0.35)
    if 1 <= hour_of_day <= 4:
        base += 0.06
    base += rng.gauss(0, 0.02)
    return min(0.85, max(0.01, base))


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius_km = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lambda = math.radians(lon2 - lon1)
    a = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    return 2 * radius_km * math.asin(math.sqrt(a))


def _pick_point(rng: random.Random) -> tuple[float, float, str]:
    if rng.random() < RANDOM_LOCATION_SHARE:
        lat = rng.uniform(BOUNDING_BOX["min_latitude"], BOUNDING_BOX["max_latitude"])
        lon = rng.uniform(BOUNDING_BOX["min_longitude"], BOUNDING_BOX["max_longitude"])
        return lat, lon, "random"
    hotspot: Hotspot = rng.choices(HOTSPOTS, weights=[h.weight for h in HOTSPOTS])[0]
    lat = rng.gauss(hotspot.latitude, HOTSPOT_JITTER_DEGREES)
    lon = rng.gauss(hotspot.longitude, HOTSPOT_JITTER_DEGREES)
    return lat, lon, hotspot.name


@dataclass(frozen=True)
class SyntheticDataConfig:
    trip_count: int = 10_000
    history_days: int = 90
    random_seed: int = 20260101  # fixed, so the "same" synthetic dataset is reproducible run to run


class TripDataSource(Protocol):
    """The swappable seam: anything with this method can supply training data. Only
    SyntheticTripDataSource exists today; a future FirestoreTripDataSource (real completed trips)
    would satisfy this same protocol and could be passed to eta_model.py/cancellation_model.py
    unchanged.
    """

    def load_trips(self) -> pd.DataFrame: ...


class SyntheticTripDataSource:
    """Generates a documented, synthetic trip history - see this module's own header comment for the
    full methodology. Deterministic for a given `SyntheticDataConfig` (a fixed random seed), so the
    "same" dataset trains the same models every time, including in tests and CI.
    """

    def __init__(self, config: SyntheticDataConfig | None = None) -> None:
        self.config = config or SyntheticDataConfig()

    def load_trips(self) -> pd.DataFrame:
        rng = random.Random(self.config.random_seed)
        now = datetime.now(tz=UTC)
        rows = []
        for i in range(self.config.trip_count):
            days_ago = rng.uniform(0, self.config.history_days)
            requested_at = now - timedelta(days=days_ago)
            day_of_week = requested_at.weekday()
            hour_of_day = rng.choices(range(24), weights=hourly_weights_for(day_of_week))[0]
            requested_at = requested_at.replace(
                hour=hour_of_day, minute=rng.randrange(60), second=rng.randrange(60)
            )

            pickup_lat, pickup_lon, pickup_name = _pick_point(rng)
            dropoff_lat, dropoff_lon, dropoff_name = _pick_point(rng)
            distance_km = max(0.3, _haversine_km(pickup_lat, pickup_lon, dropoff_lat, dropoff_lon))

            naive_duration_seconds = (distance_km / ASSUMED_AVERAGE_SPEED_KMH) * 3600
            actual_duration_seconds = naive_duration_seconds * _traffic_multiplier(hour_of_day, rng)

            cancelled = rng.random() < _cancellation_probability(
                actual_duration_seconds, hour_of_day, rng
            )

            rows.append(
                {
                    "trip_id": f"synthetic-{i}",
                    "requested_at": requested_at,
                    "day_of_week": day_of_week,
                    "hour_of_day": hour_of_day,
                    "pickup_name": pickup_name,
                    "dropoff_name": dropoff_name,
                    "distance_km": distance_km,
                    "naive_duration_seconds": naive_duration_seconds,
                    "actual_duration_seconds": actual_duration_seconds,
                    "cancelled": cancelled,
                }
            )
        return pd.DataFrame(rows)
