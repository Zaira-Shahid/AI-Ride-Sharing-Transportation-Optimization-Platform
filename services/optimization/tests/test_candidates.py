from app.candidates import (
    CANDIDATE_DIRECTION_TOLERANCE_DEGREES,
    CANDIDATE_PROXIMITY_METERS,
    JourneyInput,
    TripRequestInput,
    generate_candidates,
)
from app.geo import Point

# Roughly a Bristol -> London corridor, the same pair used for the TypeScript tests
# (functions/src/matching.test.ts), so the two are easy to compare by eye.
PICKUP = Point(51.4545, -2.5879)
DESTINATION = Point(51.5074, -0.1278)
NEAR_ORIGIN = Point(51.46, -2.58)


def journey(
    id: str = "journey-1",
    driver_id: str = "driver-1",
    origin: Point | None = NEAR_ORIGIN,
    destination: Point | None = DESTINATION,
    available_seats: int | None = 2,
) -> JourneyInput:
    return JourneyInput(id, driver_id, origin, destination, available_seats)


def request(
    id: str = "request-1", origin: Point = PICKUP, destination: Point = DESTINATION
) -> TripRequestInput:
    return TripRequestInput(id, origin, destination)


def test_accepts_a_nearby_journey_heading_the_same_way_closest_first() -> None:
    near = journey(id="near", origin=Point(51.456, -2.585))
    far = journey(id="far", origin=Point(51.465, -2.56))

    candidates = generate_candidates([request()], [far, near])

    assert [c.journey_id for c in candidates] == ["near", "far"]
    assert all(c.driver_id == "driver-1" for c in candidates)
    assert all(c.distance_meters <= CANDIDATE_PROXIMITY_METERS for c in candidates)
    assert all(
        c.bearing_difference_degrees <= CANDIDATE_DIRECTION_TOLERANCE_DEGREES for c in candidates
    )


def test_rejects_a_journey_too_far_from_the_pickup() -> None:
    far = journey(origin=Point(52.5, -1.9))
    assert generate_candidates([request()], [far]) == []


def test_rejects_a_journey_heading_the_wrong_way() -> None:
    backwards = journey(origin=Point(51.46, -2.58), destination=Point(51.42, -2.65))
    assert generate_candidates([request()], [backwards]) == []


def test_rejects_a_journey_with_no_seats_left() -> None:
    full = journey(available_seats=0)
    assert generate_candidates([request()], [full]) == []
    none = journey(available_seats=None)
    assert generate_candidates([request()], [none]) == []


def test_skips_a_journey_with_no_origin_or_no_destination() -> None:
    no_origin = journey(origin=None)
    no_destination = journey(destination=None)
    assert generate_candidates([request()], [no_origin, no_destination]) == []


def test_considers_every_request_against_every_journey() -> None:
    near_journey = journey(id="near-journey", driver_id="driver-a", origin=Point(51.456, -2.585))
    far_journey = journey(
        id="far-journey", driver_id="driver-b", origin=Point(51.465, -2.56), destination=DESTINATION
    )
    request_a = request(id="request-a")
    request_b = request(id="request-b", origin=Point(51.457, -2.586))

    candidates = generate_candidates([request_a, request_b], [near_journey, far_journey])

    pairs = {(c.request_id, c.journey_id) for c in candidates}
    assert pairs == {
        ("request-a", "near-journey"),
        ("request-a", "far-journey"),
        ("request-b", "near-journey"),
        ("request-b", "far-journey"),
    }
