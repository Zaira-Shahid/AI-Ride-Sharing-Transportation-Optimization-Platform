from typing import Any

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def cost(
    request_id: str,
    journey_id: str,
    driver_id: str = "driver-1",
    additional_distance_meters: float = 100,
) -> dict[str, Any]:
    return {
        "request_id": request_id,
        "journey_id": journey_id,
        "driver_id": driver_id,
        "additional_distance_meters": additional_distance_meters,
        "additional_duration_seconds": additional_distance_meters,
        "driver_max_detour_minutes": 1000,
        "driver_max_detour_distance_km": 1000,
        "passenger_max_extra_minutes": 1000,
        "passenger_max_detour_distance_km": 1000,
    }


def leg(from_stop: str, to_stop: str, cost_value: float) -> dict[str, Any]:
    return {
        "from_stop": from_stop,
        "to_stop": to_stop,
        "distance_meters": cost_value,
        "duration_seconds": cost_value,
    }


def single_request_matrix() -> dict[str, Any]:
    return {
        "legs": [
            leg("origin", "pickup:r1", 500),
            leg("pickup:r1", "dropoff:r1", 1000),
            leg("dropoff:r1", "destination", 500),
            leg("origin", "destination", 1800),
        ]
    }


def test_matches_and_plans_a_single_request() -> None:
    body = {
        "request_ids": ["r1"],
        "costs": [cost("r1", "j1")],
        "available_seats": {"j1": 1},
        "matrices": {"j1": single_request_matrix()},
    }

    response = client.post("/optimize", json=body)

    assert response.status_code == 200
    data = response.json()

    assert len(data["plans"]) == 1
    plan = data["plans"][0]
    assert plan["journey_id"] == "j1"
    assert plan["request_ids"] == ["r1"]
    assert plan["dropped_request_ids"] == []
    assert plan["stops"] == [
        {"kind": "pickup", "request_id": "r1"},
        {"kind": "dropoff", "request_id": "r1"},
    ]

    explanations = {e["request_id"]: e for e in data["explanations"]}
    assert explanations["r1"]["status"] == "matched"
    assert explanations["r1"]["journey_id"] == "j1"

    assert data["validation_issues"] == []
    assert data["summary"]["requested_count"] == 1
    assert data["summary"]["matched_count"] == 1
    assert data["summary"]["run_duration_seconds"] >= 0


def test_explains_a_request_with_no_candidates_at_all() -> None:
    body = {
        "request_ids": ["r1", "r2"],
        "costs": [cost("r1", "j1")],
        "available_seats": {"j1": 1},
        "matrices": {"j1": single_request_matrix()},
    }

    response = client.post("/optimize", json=body)

    assert response.status_code == 200
    explanations = {e["request_id"]: e for e in response.json()["explanations"]}
    assert explanations["r1"]["status"] == "matched"
    assert explanations["r2"]["status"] == "unmatched_no_nearby_journey"


def test_leaves_a_request_unmatched_when_the_journey_has_no_seats() -> None:
    body = {
        "request_ids": ["r1"],
        "costs": [cost("r1", "j1")],
        "available_seats": {"j1": 0},
        "matrices": {"j1": single_request_matrix()},
    }

    response = client.post("/optimize", json=body)

    assert response.status_code == 200
    data = response.json()
    assert data["plans"] == []
    explanations = {e["request_id"]: e for e in data["explanations"]}
    assert explanations["r1"]["status"] == "unmatched_no_seat_available"
