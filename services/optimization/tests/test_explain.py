from app.candidates import Candidate
from app.constraints import FeasibleCandidate
from app.explain import (
    STATUS_DROPPED_AFTER_SHARING,
    STATUS_MATCHED,
    STATUS_UNMATCHED_NO_NEARBY_JOURNEY,
    STATUS_UNMATCHED_NO_SEAT,
    STATUS_UNMATCHED_OVER_DETOUR_LIMITS,
    explain_requests,
)
from app.plan import JourneyPlan, Stop


def candidate(request_id: str, journey_id: str) -> Candidate:
    return Candidate(
        request_id=request_id,
        journey_id=journey_id,
        driver_id="driver-1",
        distance_meters=1000,
        bearing_difference_degrees=10,
    )


def feasible(request_id: str, journey_id: str) -> FeasibleCandidate:
    return FeasibleCandidate(
        request_id=request_id,
        journey_id=journey_id,
        driver_id="driver-1",
        additional_distance_meters=100,
        additional_duration_seconds=100,
    )


def plan_keeping(journey_id: str, request_ids: list[str]) -> JourneyPlan:
    stops = [
        stop
        for request_id in request_ids
        for stop in (Stop("pickup", request_id), Stop("dropoff", request_id))
    ]
    return JourneyPlan(
        journey_id=journey_id,
        driver_id="driver-1",
        stops=stops,
        request_ids=request_ids,
        dropped_request_ids=[],
        total_distance_meters=0,
        total_duration_seconds=0,
    )


def test_explains_a_request_matched_as_the_only_feasible_journey() -> None:
    explanations = explain_requests(
        ["r1"], [candidate("r1", "j1")], [feasible("r1", "j1")], [plan_keeping("j1", ["r1"])]
    )

    assert len(explanations) == 1
    assert explanations[0].status == STATUS_MATCHED
    assert explanations[0].journey_id == "j1"
    assert "only journey" in explanations[0].reason


def test_explains_a_request_matched_among_several_feasible_journeys() -> None:
    explanations = explain_requests(
        ["r1"],
        [candidate("r1", "j1"), candidate("r1", "j2")],
        [feasible("r1", "j1"), feasible("r1", "j2")],
        [plan_keeping("j1", ["r1"])],
    )

    assert explanations[0].status == STATUS_MATCHED
    assert explanations[0].journey_id == "j1"
    assert "least distance" in explanations[0].reason


def test_explains_a_request_dropped_after_sharing() -> None:
    plan = JourneyPlan(
        journey_id="j1",
        driver_id="driver-1",
        stops=[],
        request_ids=[],
        dropped_request_ids=["r1"],
        total_distance_meters=0,
        total_duration_seconds=0,
    )

    explanations = explain_requests(["r1"], [candidate("r1", "j1")], [feasible("r1", "j1")], [plan])

    assert explanations[0].status == STATUS_DROPPED_AFTER_SHARING
    assert explanations[0].journey_id == "j1"
    assert "dropped" in explanations[0].reason


def test_explains_a_request_that_fit_but_had_no_seat_left() -> None:
    explanations = explain_requests(["r1"], [candidate("r1", "j1")], [feasible("r1", "j1")], [])

    assert explanations[0].status == STATUS_UNMATCHED_NO_SEAT
    assert explanations[0].journey_id is None
    assert "seat" in explanations[0].reason


def test_explains_a_request_that_had_no_journey_within_detour_limits() -> None:
    explanations = explain_requests(["r1"], [candidate("r1", "j1")], [], [])

    assert explanations[0].status == STATUS_UNMATCHED_OVER_DETOUR_LIMITS
    assert explanations[0].journey_id is None
    assert "detour" in explanations[0].reason


def test_explains_a_request_with_no_nearby_journey_at_all() -> None:
    explanations = explain_requests(["r1"], [], [], [])

    assert explanations[0].status == STATUS_UNMATCHED_NO_NEARBY_JOURNEY
    assert explanations[0].journey_id is None
    assert "no nearby" in explanations[0].reason


def test_explains_every_request_in_a_mixed_batch_independently() -> None:
    explanations = explain_requests(
        ["matched", "no-candidates"],
        [candidate("matched", "j1")],
        [feasible("matched", "j1")],
        [plan_keeping("j1", ["matched"])],
    )

    by_request = {e.request_id: e for e in explanations}
    assert by_request["matched"].status == STATUS_MATCHED
    assert by_request["no-candidates"].status == STATUS_UNMATCHED_NO_NEARBY_JOURNEY
