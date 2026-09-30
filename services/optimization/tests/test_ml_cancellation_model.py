from app.ml.cancellation_model import predict_cancellation_risk, train_cancellation_model
from app.ml.features import features_from_request
from app.ml.synthetic_data import SyntheticDataConfig, SyntheticTripDataSource

_SOURCE = SyntheticTripDataSource(SyntheticDataConfig(trip_count=5000))


def test_trains_and_beats_random_guessing() -> None:
    result = train_cancellation_model(_SOURCE)
    assert result.trained_row_count == 5000
    # 0.5 AUC is indistinguishable from random; a real (if modest) signal should clear it with
    # room to spare, but this is a synthetic-data prototype, not a production model - don't expect
    # near-1.0 either.
    assert 0.55 < result.validation_auc < 0.95


def test_predicts_higher_risk_for_a_long_rush_hour_trip_than_a_short_midday_one() -> None:
    result = train_cancellation_model(_SOURCE)

    long_rush_hour_features = features_from_request(
        distance_km=15.0, hour_of_day=18, day_of_week=4, naive_duration_seconds=2160
    )
    short_midday_features = features_from_request(
        distance_km=2.0, hour_of_day=13, day_of_week=2, naive_duration_seconds=288
    )

    long_rush_hour_risk = predict_cancellation_risk(result.model, long_rush_hour_features)
    short_midday_risk = predict_cancellation_risk(result.model, short_midday_features)

    assert long_rush_hour_risk > short_midday_risk


def test_prediction_is_a_probability() -> None:
    result = train_cancellation_model(_SOURCE)
    features = features_from_request(
        distance_km=5.0, hour_of_day=12, day_of_week=4, naive_duration_seconds=720
    )
    risk = predict_cancellation_risk(result.model, features)
    assert 0.0 <= risk <= 1.0
