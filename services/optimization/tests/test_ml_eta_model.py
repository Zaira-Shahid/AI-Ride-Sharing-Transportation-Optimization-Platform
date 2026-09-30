from app.ml.eta_model import predict_eta_seconds, train_eta_model
from app.ml.features import features_from_request
from app.ml.synthetic_data import SyntheticDataConfig, SyntheticTripDataSource

_SOURCE = SyntheticTripDataSource(SyntheticDataConfig(trip_count=3000))


def test_trains_and_reports_a_plausible_validation_error() -> None:
    result = train_eta_model(_SOURCE)
    assert result.trained_row_count == 3000
    # A GradientBoostingRegressor should beat blind guessing on this signal, but a prototype
    # trained on synthetic data with real per-trip noise won't be near-perfect either.
    assert 0 < result.validation_mean_absolute_error_seconds < 400


def test_predicts_longer_duration_for_rush_hour_than_late_night() -> None:
    result = train_eta_model(_SOURCE)

    rush_hour_features = features_from_request(
        distance_km=8.0, hour_of_day=8, day_of_week=2, naive_duration_seconds=1152
    )
    late_night_features = features_from_request(
        distance_km=8.0, hour_of_day=3, day_of_week=2, naive_duration_seconds=1152
    )

    rush_hour_prediction = predict_eta_seconds(result.model, rush_hour_features)
    late_night_prediction = predict_eta_seconds(result.model, late_night_features)

    assert rush_hour_prediction > late_night_prediction


def test_prediction_is_a_positive_finite_number() -> None:
    result = train_eta_model(_SOURCE)
    features = features_from_request(
        distance_km=5.0, hour_of_day=12, day_of_week=4, naive_duration_seconds=720
    )
    prediction = predict_eta_seconds(result.model, features)
    assert prediction > 0
