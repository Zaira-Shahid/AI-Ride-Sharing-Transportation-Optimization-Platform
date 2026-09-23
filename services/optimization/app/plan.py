"""Plan generation (Module 6.5): for one journey with its Module 6.3/6.4 assigned requests, decides
the stop order (pickups and drop-offs) and re-validates each passenger's own detour limits against
that final, combined route - a single candidate's added distance (Module 6.2) only ever measured one
passenger added alone, so once several share a route the real added distance/time can be worse than
that pairwise estimate.

Route cost for a whole journey (Python never calls a routing server itself, same as every earlier
module) comes in as a leg-by-leg distance/duration matrix between every stop Cloud Functions has
already routed: the driver's own origin and destination, and each assigned request's pickup and
drop-off. Every ordering this module tries is scored by summing matrix legs, so no extra routing
calls are needed for whichever ordering wins.

Brute-force over every valid ordering (pickup before its own drop-off): fine for the vehicle
capacities this product supports (a handful of seats), not meant to scale to dozens of stops.
"""

from __future__ import annotations

from dataclasses import dataclass
from itertools import permutations

ORIGIN_STOP = "origin"
DESTINATION_STOP = "destination"


def _pickup_stop(request_id: str) -> str:
    return f"pickup:{request_id}"


def _dropoff_stop(request_id: str) -> str:
    return f"dropoff:{request_id}"


@dataclass(frozen=True)
class RouteLeg:
    distance_meters: float
    duration_seconds: float


@dataclass(frozen=True)
class RouteMatrix:
    """Every leg this module might need to sum, keyed by (from_stop, to_stop). Must cover every
    ordered pair among `origin`, `destination`, and each assigned request's pickup/dropoff stops,
    including each request's own direct pickup->dropoff leg (its solo trip, used to measure how much
    extra time sharing the ride actually costs that passenger) and the driver's own direct
    origin->destination leg.
    """

    legs: dict[tuple[str, str], RouteLeg]

    def leg(self, from_stop: str, to_stop: str) -> RouteLeg:
        return self.legs[(from_stop, to_stop)]


@dataclass(frozen=True)
class RequestDetourLimits:
    request_id: str
    driver_max_detour_minutes: float
    driver_max_detour_distance_km: float
    passenger_max_extra_minutes: float
    passenger_max_detour_distance_km: float


@dataclass(frozen=True)
class Stop:
    kind: str  # "pickup" | "dropoff"
    request_id: str


@dataclass(frozen=True)
class JourneyPlan:
    journey_id: str
    driver_id: str
    stops: list[Stop]
    request_ids: list[str]
    dropped_request_ids: list[str]
    total_distance_meters: float
    total_duration_seconds: float


def _valid_orderings(request_ids: list[str]) -> list[list[Stop]]:
    """Every ordering of the pickup/dropoff stops for `request_ids` where each request's pickup
    comes before its own drop-off (a request's own two stops may still end up split apart by other
    requests' stops - that is the whole point of sharing a ride).
    """
    all_stops = [
        Stop(kind, request_id) for request_id in request_ids for kind in ("pickup", "dropoff")
    ]
    orderings = []
    for candidate in permutations(all_stops):
        picked_up: set[str] = set()
        valid = True
        for stop in candidate:
            if stop.kind == "dropoff" and stop.request_id not in picked_up:
                valid = False
                break
            if stop.kind == "pickup":
                picked_up.add(stop.request_id)
        if valid:
            orderings.append(list(candidate))
    return orderings


def _stop_id(stop: Stop) -> str:
    return (
        _pickup_stop(stop.request_id) if stop.kind == "pickup" else _dropoff_stop(stop.request_id)
    )


def _score(ordering: list[Stop], matrix: RouteMatrix) -> tuple[float, float, list[str]]:
    ids = [ORIGIN_STOP, *(_stop_id(stop) for stop in ordering), DESTINATION_STOP]
    distance = sum(matrix.leg(a, b).distance_meters for a, b in zip(ids, ids[1:], strict=False))
    duration = sum(matrix.leg(a, b).duration_seconds for a, b in zip(ids, ids[1:], strict=False))
    return distance, duration, ids


def _best_ordering(
    request_ids: list[str], matrix: RouteMatrix
) -> tuple[list[Stop], list[str], float, float]:
    """The valid ordering with the least total distance, tie-broken by duration."""
    best: tuple[list[Stop], list[str], float, float] | None = None
    for ordering in _valid_orderings(request_ids):
        distance, duration, ids = _score(ordering, matrix)
        if best is None or (distance, duration) < (best[2], best[3]):
            best = (ordering, ids, distance, duration)
    assert best is not None  # request_ids is non-empty, so at least one ordering exists
    return best


def _in_vehicle_cost(ids: list[str], matrix: RouteMatrix, request_id: str) -> tuple[float, float]:
    """How far and how long `request_id`'s own passenger is actually in the vehicle, from their
    pickup to their own drop-off, along the given stop order.
    """
    start = ids.index(_pickup_stop(request_id))
    end = ids.index(_dropoff_stop(request_id))
    leg_ids = ids[start : end + 1]
    distance = sum(
        matrix.leg(a, b).distance_meters for a, b in zip(leg_ids, leg_ids[1:], strict=False)
    )
    duration = sum(
        matrix.leg(a, b).duration_seconds for a, b in zip(leg_ids, leg_ids[1:], strict=False)
    )
    return distance, duration


def _worst_offender(
    request_ids: list[str],
    ids: list[str],
    total_distance: float,
    matrix: RouteMatrix,
    limits: dict[str, RequestDetourLimits],
) -> str | None:
    """The request to drop, if this ordering leaves anyone over a detour limit: whichever passenger
    is furthest over their own limit, if any is; otherwise, if the driver's own limit is the one
    that's broken, whichever request adds the most distance (dropping it helps the driver's total
    the most). None if every limit is met.
    """
    worst_passenger: tuple[str, float] | None = None
    biggest_contributor: tuple[str, float] | None = None
    for request_id in request_ids:
        in_vehicle_distance, in_vehicle_duration = _in_vehicle_cost(ids, matrix, request_id)
        direct = matrix.leg(_pickup_stop(request_id), _dropoff_stop(request_id))
        additional_distance_km = max(0.0, in_vehicle_distance - direct.distance_meters) / 1000
        additional_minutes = max(0.0, in_vehicle_duration - direct.duration_seconds) / 60

        request_limits = limits[request_id]
        if biggest_contributor is None or additional_distance_km > biggest_contributor[1]:
            biggest_contributor = (request_id, additional_distance_km)

        distance_ratio = additional_distance_km / request_limits.passenger_max_detour_distance_km
        time_ratio = additional_minutes / request_limits.passenger_max_extra_minutes
        overage = max(distance_ratio, time_ratio)
        if overage > 1 and (worst_passenger is None or overage > worst_passenger[1]):
            worst_passenger = (request_id, overage)

    if worst_passenger is not None:
        return worst_passenger[0]

    driver_limits = limits[request_ids[0]]
    direct = matrix.leg(ORIGIN_STOP, DESTINATION_STOP)
    driver_additional_distance_km = max(0.0, total_distance - direct.distance_meters) / 1000
    if driver_additional_distance_km > driver_limits.driver_max_detour_distance_km:
        assert biggest_contributor is not None
        return biggest_contributor[0]

    return None


def generate_plan(
    journey_id: str,
    driver_id: str,
    request_ids: list[str],
    limits: dict[str, RequestDetourLimits],
    matrix: RouteMatrix,
) -> JourneyPlan:
    """The cheapest stop order for `request_ids` on this journey that keeps every kept passenger,
    and the driver, within their own detour limits - dropping whichever request is furthest over
    its own limit and retrying, as many times as it takes, until everyone left fits or nobody is
    left. Dropped requests go back to unmatched (picked up again by a later optimization run), not
    lost.
    """
    remaining = list(request_ids)
    dropped: list[str] = []

    while remaining:
        ordering, ids, distance, duration = _best_ordering(remaining, matrix)
        offender = _worst_offender(remaining, ids, distance, matrix, limits)
        if offender is None:
            return JourneyPlan(
                journey_id=journey_id,
                driver_id=driver_id,
                stops=ordering,
                request_ids=list(remaining),
                dropped_request_ids=dropped,
                total_distance_meters=distance,
                total_duration_seconds=duration,
            )
        dropped.append(offender)
        remaining.remove(offender)

    direct = matrix.leg(ORIGIN_STOP, DESTINATION_STOP)
    return JourneyPlan(
        journey_id=journey_id,
        driver_id=driver_id,
        stops=[],
        request_ids=[],
        dropped_request_ids=dropped,
        total_distance_meters=direct.distance_meters,
        total_duration_seconds=direct.duration_seconds,
    )
