from app.constraints import CandidateRouteCost, filter_feasible_candidates, is_within_detour_limits

LIMITS = {
    "driver_max_detour_minutes": 10,
    "driver_max_detour_distance_km": 3,
    "passenger_max_extra_minutes": 10,
    "passenger_max_detour_distance_km": 3,
}


def cost(
    additional_distance_meters: float,
    additional_duration_seconds: float,
    request_id: str = "request-1",
    journey_id: str = "journey-1",
    **overrides: float,
) -> CandidateRouteCost:
    fields = {**LIMITS, **overrides}
    return CandidateRouteCost(
        request_id=request_id,
        journey_id=journey_id,
        driver_id="driver-1",
        additional_distance_meters=additional_distance_meters,
        additional_duration_seconds=additional_duration_seconds,
        **fields,
    )


def test_is_within_limits_when_added_distance_and_time_are_within_every_limit() -> None:
    assert is_within_detour_limits(cost(1_500, 300)) is True


def test_is_not_within_limits_when_the_added_distance_is_over_the_driver_detour_limit() -> None:
    assert is_within_detour_limits(cost(3_500, 100)) is False


def test_is_not_within_limits_when_the_added_time_is_over_the_passenger_extra_time_limit() -> None:
    assert is_within_detour_limits(cost(500, 700)) is False


def test_is_not_within_limits_when_the_tighter_of_the_two_detour_limits_is_exceeded() -> None:
    assert is_within_detour_limits(cost(1_500, 100, passenger_max_detour_distance_km=1)) is False


def test_filter_feasible_candidates_keeps_only_the_ones_within_every_limit() -> None:
    good = cost(1_500, 300, request_id="good")
    bad = cost(3_500, 100, request_id="bad")

    feasible = filter_feasible_candidates([good, bad])

    assert [c.request_id for c in feasible] == ["good"]
    assert feasible[0].additional_distance_meters == 1_500
    assert feasible[0].additional_duration_seconds == 300
