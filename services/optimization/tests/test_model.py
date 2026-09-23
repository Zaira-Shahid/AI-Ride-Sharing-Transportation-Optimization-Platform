from app.constraints import FeasibleCandidate
from app.model import solve_assignment


def candidate(
    request_id: str, journey_id: str, driver_id: str = "driver-1", distance: float = 100
) -> FeasibleCandidate:
    return FeasibleCandidate(
        request_id=request_id,
        journey_id=journey_id,
        driver_id=driver_id,
        additional_distance_meters=distance,
        additional_duration_seconds=distance,
    )


def test_is_empty_when_there_are_no_candidates() -> None:
    assert solve_assignment([], {}) == []


def test_matches_a_single_feasible_candidate() -> None:
    result = solve_assignment([candidate("r1", "j1")], {"j1": 1})

    assert len(result) == 1
    assert result[0].request_id == "r1"
    assert result[0].journey_id == "j1"


def test_never_matches_a_journey_past_its_seats() -> None:
    candidates = [candidate("r1", "j1"), candidate("r2", "j1")]

    result = solve_assignment(candidates, {"j1": 1})

    assert len(result) == 1


def test_matches_up_to_capacity_when_seats_allow_it() -> None:
    candidates = [candidate("r1", "j1"), candidate("r2", "j1")]

    result = solve_assignment(candidates, {"j1": 2})

    assert {a.request_id for a in result} == {"r1", "r2"}


def test_never_matches_the_same_request_to_two_journeys() -> None:
    candidates = [candidate("r1", "j1"), candidate("r1", "j2")]

    result = solve_assignment(candidates, {"j1": 1, "j2": 1})

    assert len(result) == 1


def test_maximises_how_many_requests_are_matched_over_the_shortest_detour() -> None:
    # r1 fits either journey; r2 only fits j1. Matching both (r1->j2, r2->j1) beats matching just
    # one, even though sending r1 to j1 alone would add less distance than either journey it takes
    # to match both of them.
    candidates = [
        candidate("r1", "j1", distance=10),
        candidate("r1", "j2", distance=9_000),
        candidate("r2", "j1", distance=20),
    ]

    result = solve_assignment(candidates, {"j1": 1, "j2": 1})

    assert {a.request_id for a in result} == {"r1", "r2"}
    assert {a.journey_id for a in result} == {"j1", "j2"}


def test_breaks_a_tie_in_matched_count_by_the_least_total_added_distance() -> None:
    # One journey, two seats, three otherwise-equal requests: exactly two get matched either way, so
    # the two cheapest must win.
    candidates = [
        candidate("cheap", "j1", distance=100),
        candidate("middle", "j1", distance=200),
        candidate("expensive", "j1", distance=300),
    ]

    result = solve_assignment(candidates, {"j1": 2})

    assert {a.request_id for a in result} == {"cheap", "middle"}


def test_gives_no_journey_more_than_its_seats_even_with_none_recorded() -> None:
    result = solve_assignment([candidate("r1", "j1")], {})
    assert result == []
