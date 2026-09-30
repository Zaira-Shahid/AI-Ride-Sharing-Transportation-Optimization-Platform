from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

_VALID_REQUEST = {
    "distance_km": 8.0,
    "hour_of_day": 8,
    "day_of_week": 2,
    "naive_duration_seconds": 1152,
}


def test_status_reports_prototype_and_synthetic_labels() -> None:
    response = client.get("/ml/status")
    assert response.status_code == 200
    body = response.json()
    assert body["prototype"] is True
    assert body["trained_on"] == "synthetic_data"
    assert body["trained_row_count"] > 0
    assert "synthetic" in body["warning"].lower()
    assert "not production-ready" in body["warning"]


def test_eta_predict_returns_a_labeled_positive_duration() -> None:
    response = client.post("/ml/eta/predict", json=_VALID_REQUEST)
    assert response.status_code == 200
    body = response.json()
    assert body["predicted_duration_seconds"] > 0
    assert body["prototype"] is True
    assert body["trained_on"] == "synthetic_data"


def test_cancellation_predict_returns_a_labeled_probability() -> None:
    response = client.post("/ml/cancellation/predict", json=_VALID_REQUEST)
    assert response.status_code == 200
    body = response.json()
    assert 0.0 <= body["cancellation_risk"] <= 1.0
    assert body["prototype"] is True
    assert body["trained_on"] == "synthetic_data"


def test_eta_predict_rejects_out_of_range_hour() -> None:
    bad_request = {**_VALID_REQUEST, "hour_of_day": 24}
    response = client.post("/ml/eta/predict", json=bad_request)
    assert response.status_code == 422


def test_eta_predict_rejects_non_positive_distance() -> None:
    bad_request = {**_VALID_REQUEST, "distance_km": 0}
    response = client.post("/ml/eta/predict", json=bad_request)
    assert response.status_code == 422


def test_cancellation_predict_rejects_out_of_range_day_of_week() -> None:
    bad_request = {**_VALID_REQUEST, "day_of_week": 7}
    response = client.post("/ml/cancellation/predict", json=bad_request)
    assert response.status_code == 422
