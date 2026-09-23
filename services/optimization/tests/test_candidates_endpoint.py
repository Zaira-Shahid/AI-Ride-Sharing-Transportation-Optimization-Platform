from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_returns_no_candidates_for_an_empty_batch() -> None:
    response = client.post("/candidates", json={"requests": [], "journeys": []})

    assert response.status_code == 200
    assert response.json() == {"candidates": []}


def test_returns_a_candidate_for_a_nearby_compatible_journey() -> None:
    body = {
        "requests": [
            {
                "id": "r1",
                "origin": {"latitude": 51.50, "longitude": -0.10},
                "destination": {"latitude": 51.51, "longitude": -0.09},
            }
        ],
        "journeys": [
            {
                "id": "j1",
                "driver_id": "driver-1",
                "origin": {"latitude": 51.50, "longitude": -0.101},
                "destination": {"latitude": 51.52, "longitude": -0.08},
                "available_seats": 2,
            }
        ],
    }

    response = client.post("/candidates", json=body)

    assert response.status_code == 200
    candidates = response.json()["candidates"]
    assert len(candidates) == 1
    assert candidates[0]["request_id"] == "r1"
    assert candidates[0]["journey_id"] == "j1"


def test_skips_a_journey_with_no_seats_left() -> None:
    body = {
        "requests": [
            {
                "id": "r1",
                "origin": {"latitude": 51.50, "longitude": -0.10},
                "destination": {"latitude": 51.51, "longitude": -0.09},
            }
        ],
        "journeys": [
            {
                "id": "j1",
                "driver_id": "driver-1",
                "origin": {"latitude": 51.50, "longitude": -0.101},
                "destination": {"latitude": 51.52, "longitude": -0.08},
                "available_seats": 0,
            }
        ],
    }

    response = client.post("/candidates", json=body)

    assert response.json() == {"candidates": []}
