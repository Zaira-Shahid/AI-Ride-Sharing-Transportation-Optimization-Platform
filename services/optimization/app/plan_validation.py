"""Plan validation (Module 6.6): a final defensive pass over a whole batch's Module 6.5 plans
together, not one journey at a time - every earlier module already keeps its own output correct on
its own terms (6.3/6.4 never double-assigns a request or overfills a journey; 6.5 never leaves a
plan's own stops malformed or over anyone's detour limit), so none of these checks are expected to
ever actually fail on correct input. They exist so a bug anywhere earlier in the pipeline is caught
here, before its output reaches Cloud Functions/Firestore, instead of silently corrupting live data.

Pure: returns the problems found (empty means the batch is fine) rather than raising or dropping
anything itself - what to do about a bad batch is a decision for whoever calls this.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass

from app.plan import JourneyPlan


@dataclass(frozen=True)
class PlanValidationIssue:
    journey_id: str
    reason: str


def _seat_capacity_issues(plan: JourneyPlan, available_seats: dict[str, int]) -> list[str]:
    seats = available_seats.get(plan.journey_id, 0)
    if len(plan.request_ids) > seats:
        return [
            f"plan carries {len(plan.request_ids)} requests but the journey only has {seats} seats"
        ]
    return []


def _stop_structure_issues(plan: JourneyPlan) -> list[str]:
    issues = []
    stop_counts = Counter((stop.kind, stop.request_id) for stop in plan.stops)
    pickup_index = {
        stop.request_id: i for i, stop in enumerate(plan.stops) if stop.kind == "pickup"
    }
    dropoff_index = {
        stop.request_id: i for i, stop in enumerate(plan.stops) if stop.kind == "dropoff"
    }

    for request_id in plan.request_ids:
        if stop_counts[("pickup", request_id)] != 1 or stop_counts[("dropoff", request_id)] != 1:
            issues.append(f"request {request_id} does not have exactly one pickup and one dropoff")
            continue
        if pickup_index[request_id] >= dropoff_index[request_id]:
            issues.append(f"request {request_id}'s dropoff comes before its own pickup")

    known_request_ids = set(plan.request_ids)
    stray = {stop.request_id for stop in plan.stops} - known_request_ids
    if stray:
        issues.append(f"plan has stops for requests not in its own request list: {sorted(stray)}")

    return issues


def validate_plans(
    plans: list[JourneyPlan], available_seats: dict[str, int]
) -> list[PlanValidationIssue]:
    """Every problem found across the whole batch: a journey carrying more requests than it has
    seats for, a plan whose own stops are malformed (a request without exactly one pickup and one
    dropoff, a dropoff scheduled before its own pickup, or a stop for a request the plan doesn't
    list), and any request kept by more than one journey's plan at once.
    """
    issues: list[PlanValidationIssue] = []
    seen_in: dict[str, str] = {}

    for plan in plans:
        for reason in [
            *_seat_capacity_issues(plan, available_seats),
            *_stop_structure_issues(plan),
        ]:
            issues.append(PlanValidationIssue(journey_id=plan.journey_id, reason=reason))

        for request_id in plan.request_ids:
            if request_id in seen_in:
                issues.append(
                    PlanValidationIssue(
                        journey_id=plan.journey_id,
                        reason=(
                            f"request {request_id} is also kept by journey {seen_in[request_id]}'s "
                            "plan"
                        ),
                    )
                )
            else:
                seen_in[request_id] = plan.journey_id

    return issues
