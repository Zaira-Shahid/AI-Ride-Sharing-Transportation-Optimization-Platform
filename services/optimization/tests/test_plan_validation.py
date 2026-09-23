from app.plan import JourneyPlan, Stop
from app.plan_validation import validate_plans


def plan(
    journey_id: str,
    driver_id: str = "driver-1",
    stops: list[Stop] | None = None,
    request_ids: list[str] | None = None,
) -> JourneyPlan:
    return JourneyPlan(
        journey_id=journey_id,
        driver_id=driver_id,
        stops=stops if stops is not None else [],
        request_ids=request_ids if request_ids is not None else [],
        dropped_request_ids=[],
        total_distance_meters=0,
        total_duration_seconds=0,
    )


def valid_single_request_plan(journey_id: str, request_id: str) -> JourneyPlan:
    return plan(
        journey_id,
        stops=[Stop("pickup", request_id), Stop("dropoff", request_id)],
        request_ids=[request_id],
    )


def test_is_empty_for_an_empty_batch() -> None:
    assert validate_plans([], {}) == []


def test_is_empty_for_a_well_formed_batch() -> None:
    plans = [valid_single_request_plan("j1", "r1"), valid_single_request_plan("j2", "r2")]

    assert validate_plans(plans, {"j1": 1, "j2": 1}) == []


def test_flags_a_journey_carrying_more_requests_than_it_has_seats() -> None:
    plans = [
        plan(
            "j1",
            stops=[
                Stop("pickup", "r1"),
                Stop("pickup", "r2"),
                Stop("dropoff", "r1"),
                Stop("dropoff", "r2"),
            ],
            request_ids=["r1", "r2"],
        )
    ]

    issues = validate_plans(plans, {"j1": 1})

    assert len(issues) == 1
    assert issues[0].journey_id == "j1"
    assert "2 requests" in issues[0].reason
    assert "1 seats" in issues[0].reason


def test_flags_a_request_missing_its_dropoff() -> None:
    plans = [plan("j1", stops=[Stop("pickup", "r1")], request_ids=["r1"])]

    issues = validate_plans(plans, {"j1": 1})

    assert len(issues) == 1
    assert "r1" in issues[0].reason


def test_flags_a_dropoff_scheduled_before_its_own_pickup() -> None:
    plans = [
        plan(
            "j1",
            stops=[Stop("dropoff", "r1"), Stop("pickup", "r1")],
            request_ids=["r1"],
        )
    ]

    issues = validate_plans(plans, {"j1": 1})

    assert len(issues) == 1
    assert "before its own pickup" in issues[0].reason


def test_flags_a_stop_for_a_request_the_plan_does_not_list() -> None:
    plans = [
        plan(
            "j1",
            stops=[Stop("pickup", "r1"), Stop("dropoff", "r1"), Stop("pickup", "r2")],
            request_ids=["r1"],
        )
    ]

    issues = validate_plans(plans, {"j1": 5})

    assert len(issues) == 1
    assert "r2" in issues[0].reason


def test_flags_a_request_kept_by_two_journeys_at_once() -> None:
    plans = [valid_single_request_plan("j1", "r1"), valid_single_request_plan("j2", "r1")]

    issues = validate_plans(plans, {"j1": 1, "j2": 1})

    assert len(issues) == 1
    assert issues[0].journey_id == "j2"
    assert "r1" in issues[0].reason
    assert "j1" in issues[0].reason
