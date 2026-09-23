from app.plan import (
    RequestDetourLimits,
    RouteLeg,
    RouteMatrix,
    Stop,
    generate_plan,
)


def build_matrix(positions: dict[str, float]) -> RouteMatrix:
    """A matrix over stops laid out on a line: leg cost is just the distance between positions
    (duration set to the same number, so a test's minute limits and km limits line up directly).
    """
    legs = {}
    for from_stop, from_position in positions.items():
        for to_stop, to_position in positions.items():
            if from_stop != to_stop:
                cost = abs(to_position - from_position)
                legs[(from_stop, to_stop)] = RouteLeg(distance_meters=cost, duration_seconds=cost)
    return RouteMatrix(legs=legs)


def generous_limits(request_id: str) -> RequestDetourLimits:
    return RequestDetourLimits(
        request_id=request_id,
        driver_max_detour_minutes=1000,
        driver_max_detour_distance_km=1000,
        passenger_max_extra_minutes=1000,
        passenger_max_detour_distance_km=1000,
    )


def test_generates_no_stops_when_there_are_no_requests() -> None:
    matrix = build_matrix({"origin": 0, "destination": 500})

    plan = generate_plan("j1", "d1", [], {}, matrix)

    assert plan.stops == []
    assert plan.request_ids == []
    assert plan.dropped_request_ids == []
    assert plan.total_distance_meters == 500
    assert plan.total_duration_seconds == 500


def test_generates_pickup_then_dropoff_for_a_single_request() -> None:
    matrix = build_matrix({"origin": 0, "pickup:r1": 500, "dropoff:r1": 1500, "destination": 2000})

    plan = generate_plan("j1", "d1", ["r1"], {"r1": generous_limits("r1")}, matrix)

    assert plan.stops == [Stop("pickup", "r1"), Stop("dropoff", "r1")]
    assert plan.request_ids == ["r1"]
    assert plan.dropped_request_ids == []
    assert plan.total_distance_meters == 2000
    assert plan.total_duration_seconds == 2000


def test_picks_the_cheapest_valid_stop_order_over_a_nested_one() -> None:
    # Nesting r2 inside r1 (pickup r1, pickup r2, dropoff r2, dropoff r1) would need to double back;
    # interleaving them (pickup r1, pickup r2, dropoff r1, dropoff r2) follows the line straight
    # through and costs less total distance.
    matrix = build_matrix(
        {
            "origin": 0,
            "pickup:r1": 100,
            "pickup:r2": 200,
            "dropoff:r1": 300,
            "dropoff:r2": 400,
            "destination": 500,
        }
    )
    limits = {"r1": generous_limits("r1"), "r2": generous_limits("r2")}

    plan = generate_plan("j1", "d1", ["r1", "r2"], limits, matrix)

    assert plan.stops == [
        Stop("pickup", "r1"),
        Stop("pickup", "r2"),
        Stop("dropoff", "r1"),
        Stop("dropoff", "r2"),
    ]
    assert plan.dropped_request_ids == []
    assert plan.total_distance_meters == 500


def test_drops_the_request_whose_own_detour_limit_is_exceeded_and_replans() -> None:
    # r2's drop-off sits behind its own pickup, forcing the vehicle to backtrack while r1 is aboard
    # (the cheapest order is pickup r1, pickup r2, dropoff r2, dropoff r1) - r1 ends up carried
    # 1580m for what is normally an 800m trip (780m/0.78km of it caused by sharing with r2), well
    # past a tight 500m passenger limit. r2 itself is barely detoured (0m) since its own stops stay
    # adjacent.
    matrix = build_matrix(
        {
            "origin": 0,
            "pickup:r1": 100,
            "dropoff:r1": 900,
            "pickup:r2": 500,
            "dropoff:r2": 110,
            "destination": 1000,
        }
    )
    limits = {
        "r1": RequestDetourLimits(
            request_id="r1",
            driver_max_detour_minutes=1000,
            driver_max_detour_distance_km=5,
            passenger_max_extra_minutes=1000,
            passenger_max_detour_distance_km=0.5,
        ),
        "r2": RequestDetourLimits(
            request_id="r2",
            driver_max_detour_minutes=1000,
            driver_max_detour_distance_km=5,
            passenger_max_extra_minutes=1000,
            passenger_max_detour_distance_km=5,
        ),
    }

    plan = generate_plan("j1", "d1", ["r1", "r2"], limits, matrix)

    assert plan.request_ids == ["r2"]
    assert plan.dropped_request_ids == ["r1"]
    assert plan.stops == [Stop("pickup", "r2"), Stop("dropoff", "r2")]
    assert plan.total_distance_meters == 1780


def test_drops_a_request_that_alone_still_breaks_the_drivers_own_limit() -> None:
    # r1's pickup/dropoff sit well off the direct route; even carrying just this one passenger blows
    # the driver's own (tight, 1km) detour budget, so nobody ends up matched to this journey.
    matrix = build_matrix({"origin": 0, "pickup:r1": 1000, "dropoff:r1": 1100, "destination": 200})
    limits = {
        "r1": RequestDetourLimits(
            request_id="r1",
            driver_max_detour_minutes=1000,
            driver_max_detour_distance_km=1,
            passenger_max_extra_minutes=1000,
            passenger_max_detour_distance_km=1000,
        )
    }

    plan = generate_plan("j1", "d1", ["r1"], limits, matrix)

    assert plan.stops == []
    assert plan.request_ids == []
    assert plan.dropped_request_ids == ["r1"]
    assert plan.total_distance_meters == 200
