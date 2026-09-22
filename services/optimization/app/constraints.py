"""Constraint engine (Module 6.2): filters Module 6.1's candidates down to the ones that fit both
the driver's own detour limits and the passenger's flexibility preferences - the same check as
checkRouteCompatibility on the TypeScript side (Module 5.4, functions/src/matching.ts), applied to a
whole batch at once instead of one candidate.

The route cost (the added distance and time a candidate's pickup and destination would put on the
driver's journey) is computed by Cloud Functions, which already owns the routing infrastructure
(calculateRoute, its cache and rate limits, functions/src/routing.ts) - this module only applies
limits to numbers it is given; it never calls a routing server itself.

Capacity (how many passengers a journey has room for) is not re-checked here: Module 6.1 already
drops a journey with no seats left, and how many requests can actually share one journey's seats
at once is the OR-Tools model's job (Module 6.3) once it is deciding groupings, not a single
candidate's own feasibility.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CandidateRouteCost:
    """One Module 6.1 candidate, with its route cost and everyone's detour limits attached -
    everything needed to judge it, the way checkCandidateRoute's input does on the TypeScript side.
    """

    request_id: str
    journey_id: str
    driver_id: str
    additional_distance_meters: float
    additional_duration_seconds: float
    driver_max_detour_minutes: float
    driver_max_detour_distance_km: float
    passenger_max_extra_minutes: float
    passenger_max_detour_distance_km: float


@dataclass(frozen=True)
class FeasibleCandidate:
    """A candidate that fits every detour limit, with the cost the OR-Tools model (Module 6.3) will
    weigh it by.
    """

    request_id: str
    journey_id: str
    driver_id: str
    additional_distance_meters: float
    additional_duration_seconds: float


def is_within_detour_limits(cost: CandidateRouteCost) -> bool:
    """Whether the added distance and time fit both the driver's detour limits and the passenger's
    flexibility preferences - the tighter of the two always decides, same as on the TypeScript side.
    """
    additional_distance_km = cost.additional_distance_meters / 1000
    additional_minutes = cost.additional_duration_seconds / 60
    return (
        additional_distance_km <= cost.driver_max_detour_distance_km
        and additional_minutes <= cost.driver_max_detour_minutes
        and additional_distance_km <= cost.passenger_max_detour_distance_km
        and additional_minutes <= cost.passenger_max_extra_minutes
    )


def filter_feasible_candidates(costs: list[CandidateRouteCost]) -> list[FeasibleCandidate]:
    """Module 6.1's candidates, narrowed to the ones whose route cost fits every detour limit."""
    return [
        FeasibleCandidate(
            request_id=cost.request_id,
            journey_id=cost.journey_id,
            driver_id=cost.driver_id,
            additional_distance_meters=cost.additional_distance_meters,
            additional_duration_seconds=cost.additional_duration_seconds,
        )
        for cost in costs
        if is_within_detour_limits(cost)
    ]
