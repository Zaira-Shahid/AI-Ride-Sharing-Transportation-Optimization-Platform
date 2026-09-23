"""The OR-Tools model (Modules 6.3 and 6.4, decided together): decides which requests are assigned
to which journeys, among Module 6.2's feasible candidates.

Maximizes how many requests get matched first, and only among plans that match the same number
tie-breaks on the least total added distance across every journey - matching one more passenger
always outweighs any distance saved elsewhere, never the other way round, so nobody is left
unmatched just to keep someone else's detour shorter.

Deciding which requests join which journey only: the order of pickups and drop-offs when two or
more passengers share one journey is Module 6.5's job (plan generation).
"""

from __future__ import annotations

from dataclasses import dataclass

from ortools.sat.python import cp_model

from app.constraints import FeasibleCandidate


@dataclass(frozen=True)
class Assignment:
    request_id: str
    journey_id: str
    driver_id: str
    additional_distance_meters: float
    additional_duration_seconds: float


def solve_assignment(
    candidates: list[FeasibleCandidate], available_seats: dict[str, int]
) -> list[Assignment]:
    """The best assignment of requests to journeys among `candidates`: each request goes to at most
    one journey, each journey takes no more requests than `available_seats` gives it room for
    (looked up by journey ID; a journey missing from it gets none), maximizing how many requests are
    matched and, among ties, minimizing the total added distance. Empty when there is nothing to
    assign, or no feasible assignment exists.
    """
    if not candidates:
        return []

    model = cp_model.CpModel()
    variables = {
        (c.request_id, c.journey_id): model.new_bool_var(f"x_{c.request_id}_{c.journey_id}")
        for c in candidates
    }

    by_request: dict[str, list[FeasibleCandidate]] = {}
    by_journey: dict[str, list[FeasibleCandidate]] = {}
    for c in candidates:
        by_request.setdefault(c.request_id, []).append(c)
        by_journey.setdefault(c.journey_id, []).append(c)

    # Each request is matched to at most one journey.
    for options in by_request.values():
        model.add(sum(variables[c.request_id, c.journey_id] for c in options) <= 1)

    # A journey takes no more requests than the seats it has (one passenger per request, always).
    for journey_id, options in by_journey.items():
        seats = available_seats.get(journey_id, 0)
        model.add(sum(variables[c.request_id, journey_id] for c in options) <= seats)

    total_matched = sum(variables.values())
    total_added_distance = sum(
        round(c.additional_distance_meters) * variables[c.request_id, c.journey_id]
        for c in candidates
    )
    # Large enough that matching one more request always outweighs any distance saved: no feasible
    # plan can add more total distance than every candidate's own distance summed.
    distance_weight = round(sum(c.additional_distance_meters for c in candidates)) + 1
    model.maximize(total_matched * distance_weight - total_added_distance)

    solver = cp_model.CpSolver()
    status = solver.solve(model)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return []

    return [
        Assignment(
            request_id=c.request_id,
            journey_id=c.journey_id,
            driver_id=c.driver_id,
            additional_distance_meters=c.additional_distance_meters,
            additional_duration_seconds=c.additional_duration_seconds,
        )
        for c in candidates
        if solver.value(variables[c.request_id, c.journey_id]) == 1
    ]
