"""Explainability (Module 6.7): for every open trip request in a batch, a plain-language answer to
the admin questions the spec asks for (section 14) - "why was this passenger assigned", "what
constraint prevented a match" - grounded in what modules 6.1-6.5 actually computed for that request,
not an invented weighted score (the real objective, decided in module 6.3/6.4, is simply "match as
many requests as possible, then prefer the least total added distance").

A request's outcome is read off the pipeline stage it fell out at: never even a nearby candidate
(6.1), a nearby candidate but none within anyone's detour limits (6.2), within limits but not
actually assigned a seat (6.3/6.4 - lost out to other requests under the batch's objective),
assigned and kept (6.5), or assigned but later dropped once its journey's stops were combined with
others' (6.5, only once other passengers are sharing the ride).
"""

from __future__ import annotations

from dataclasses import dataclass

from app.candidates import Candidate
from app.constraints import FeasibleCandidate
from app.plan import JourneyPlan

STATUS_MATCHED = "matched"
STATUS_DROPPED_AFTER_SHARING = "dropped_after_sharing"
STATUS_UNMATCHED_NO_SEAT = "unmatched_no_seat_available"
STATUS_UNMATCHED_OVER_DETOUR_LIMITS = "unmatched_over_detour_limits"
STATUS_UNMATCHED_NO_NEARBY_JOURNEY = "unmatched_no_nearby_journey"


@dataclass(frozen=True)
class RequestExplanation:
    request_id: str
    status: str
    journey_id: str | None
    reason: str


def _group_by_request(candidates: list[Candidate]) -> dict[str, list[Candidate]]:
    grouped: dict[str, list[Candidate]] = {}
    for candidate in candidates:
        grouped.setdefault(candidate.request_id, []).append(candidate)
    return grouped


def _group_feasible_by_request(
    feasible: list[FeasibleCandidate],
) -> dict[str, list[FeasibleCandidate]]:
    grouped: dict[str, list[FeasibleCandidate]] = {}
    for candidate in feasible:
        grouped.setdefault(candidate.request_id, []).append(candidate)
    return grouped


def explain_requests(
    request_ids: list[str],
    candidates: list[Candidate],
    feasible: list[FeasibleCandidate],
    plans: list[JourneyPlan],
) -> list[RequestExplanation]:
    """One explanation per request in `request_ids`, covering every outcome the pipeline can reach:
    matched (kept in a plan), dropped after being assigned once its journey's route was shared with
    others, or unmatched - with the reason traced back to the earliest stage it fell out at.
    """
    candidates_by_request = _group_by_request(candidates)
    feasible_by_request = _group_feasible_by_request(feasible)

    matched_journey: dict[str, str] = {}
    dropped_journey: dict[str, str] = {}
    for plan in plans:
        for request_id in plan.request_ids:
            matched_journey[request_id] = plan.journey_id
        for request_id in plan.dropped_request_ids:
            dropped_journey[request_id] = plan.journey_id

    explanations = []
    for request_id in request_ids:
        if request_id in matched_journey:
            journey_id = matched_journey[request_id]
            options = feasible_by_request.get(request_id, [])
            if len(options) > 1:
                reason = (
                    f"assigned to journey {journey_id}: matched the most requests overall, and "
                    f"among {len(options)} journeys it fit within everyone's detour limits, this "
                    "one added the least distance"
                )
            else:
                reason = (
                    f"assigned to journey {journey_id}: the only journey it fit within everyone's "
                    "detour limits"
                )
            explanations.append(RequestExplanation(request_id, STATUS_MATCHED, journey_id, reason))
        elif request_id in dropped_journey:
            journey_id = dropped_journey[request_id]
            reason = (
                f"assigned to journey {journey_id}, but dropped once that journey's stop order "
                "was combined with other passengers' pickups and drop-offs, pushing someone past "
                "their own detour limit"
            )
            explanations.append(
                RequestExplanation(request_id, STATUS_DROPPED_AFTER_SHARING, journey_id, reason)
            )
        elif request_id in feasible_by_request:
            count = len(feasible_by_request[request_id])
            reason = (
                f"fit within everyone's detour limits on {count} journey(s), but none had a seat "
                "left once requests were matched to maximize the total number matched"
            )
            explanations.append(
                RequestExplanation(request_id, STATUS_UNMATCHED_NO_SEAT, None, reason)
            )
        elif request_id in candidates_by_request:
            count = len(candidates_by_request[request_id])
            reason = (
                f"found {count} nearby, direction-compatible journey(s), but none fit the "
                "driver's or the passenger's detour limits"
            )
            explanations.append(
                RequestExplanation(request_id, STATUS_UNMATCHED_OVER_DETOUR_LIMITS, None, reason)
            )
        else:
            reason = "no nearby, direction-compatible journey with a free seat was found"
            explanations.append(
                RequestExplanation(request_id, STATUS_UNMATCHED_NO_NEARBY_JOURNEY, None, reason)
            )

    return explanations
