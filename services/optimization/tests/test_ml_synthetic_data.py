from app.ml.synthetic_data import SyntheticDataConfig, SyntheticTripDataSource
from app.ml.timing import WEEKDAY_HOURLY_WEIGHTS, WEEKEND_HOURLY_WEIGHTS


def test_generates_configured_row_count() -> None:
    source = SyntheticTripDataSource(SyntheticDataConfig(trip_count=500))
    data = source.load_trips()
    assert len(data) == 500


def test_deterministic_for_a_fixed_seed() -> None:
    """`requested_at` is anchored to wall-clock "now" (load_trips()'s own docstring says nothing
    promises otherwise), so it can differ by microseconds between two calls even with the same
    seed - that's expected, not a bug. What must be reproducible, and is what training actually
    depends on (app/ml/features.py), is every other column: the feature columns plus the
    `cancelled` target.
    """
    config = SyntheticDataConfig(trip_count=200, random_seed=42)
    first = SyntheticTripDataSource(config).load_trips()
    second = SyntheticTripDataSource(config).load_trips()
    reproducible_columns = [
        "day_of_week",
        "hour_of_day",
        "pickup_name",
        "dropoff_name",
        "distance_km",
        "naive_duration_seconds",
        "actual_duration_seconds",
        "cancelled",
    ]
    assert first[reproducible_columns].equals(second[reproducible_columns])


def test_different_seeds_produce_different_data() -> None:
    config_a = SyntheticDataConfig(trip_count=200, random_seed=1)
    config_b = SyntheticDataConfig(trip_count=200, random_seed=2)
    first = SyntheticTripDataSource(config_a).load_trips()
    second = SyntheticTripDataSource(config_b).load_trips()
    assert not first.equals(second)


def test_expected_columns_present() -> None:
    data = SyntheticTripDataSource(SyntheticDataConfig(trip_count=50)).load_trips()
    expected = {
        "trip_id",
        "requested_at",
        "day_of_week",
        "hour_of_day",
        "pickup_name",
        "dropoff_name",
        "distance_km",
        "naive_duration_seconds",
        "actual_duration_seconds",
        "cancelled",
    }
    assert expected.issubset(set(data.columns))


def test_value_ranges_are_plausible() -> None:
    data = SyntheticTripDataSource(SyntheticDataConfig(trip_count=2000)).load_trips()
    assert data["distance_km"].min() > 0
    assert data["distance_km"].max() < 100
    assert data["hour_of_day"].between(0, 23).all()
    assert data["day_of_week"].between(0, 6).all()
    assert data["naive_duration_seconds"].min() > 0
    assert (data["actual_duration_seconds"] >= 0).all()
    assert data["cancelled"].isin([True, False]).all()


def test_cancellation_rate_is_neither_trivial_nor_saturated() -> None:
    data = SyntheticTripDataSource(SyntheticDataConfig(trip_count=5000)).load_trips()
    rate = data["cancelled"].mean()
    assert 0.02 < rate < 0.5


def test_longer_trips_cancel_more_often_on_average() -> None:
    """The invented cancellation rule's own dominant term (synthetic_data.py's header comment) is
    trip duration - assert that shape survives end to end in the generated data.
    """
    data = SyntheticTripDataSource(SyntheticDataConfig(trip_count=8000)).load_trips()
    median_duration = data["actual_duration_seconds"].median()
    short_trips = data[data["actual_duration_seconds"] <= median_duration]
    long_trips = data[data["actual_duration_seconds"] > median_duration]
    assert long_trips["cancelled"].mean() > short_trips["cancelled"].mean()


def test_hourly_weight_tables_cover_all_24_hours() -> None:
    assert len(WEEKDAY_HOURLY_WEIGHTS) == 24
    assert len(WEEKEND_HOURLY_WEIGHTS) == 24
    assert all(w > 0 for w in WEEKDAY_HOURLY_WEIGHTS)
    assert all(w > 0 for w in WEEKEND_HOURLY_WEIGHTS)
