"""Optimization run logging (Module 6.8, the last of Phase 6): a single structured summary of one
batch run, assembled from what modules 6.1-6.7 already computed - how many requests came in, how
many matched (and how many of those were later dropped by Module 6.5's sharing re-check), how many
stayed unmatched and why, how many journeys actually carry a passenger, the total distance/duration
across them, and how many Module 6.6 validation issues turned up.

The Python service stays stateless (it has never touched Firestore itself, same as every earlier
module): this only assembles the summary and returns it in the service's response. Whether and
where it gets persisted (a new Firestore collection, most likely) is Cloud Functions' decision, and
its own small follow-up - not part of this module.

Timing is a plain float passed in by the caller (whoever measured how long the run took) rather than
read from the clock in here, so this stays a pure function like the rest of the pipeline.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass

from app.explain import STATUS_DROPPED_AFTER_SHARING, STATUS_MATCHED, RequestExplanation
from app.plan import JourneyPlan
from app.plan_validation import PlanValidationIssue


@dataclass(frozen=True)
class RunSummary:
    requested_count: int
    matched_count: int
    dropped_after_sharing_count: int
    unmatched_count: int
    unmatched_by_reason: dict[str, int]
    journeys_used: int
    total_distance_meters: float
    total_duration_seconds: float
    validation_issue_count: int
    run_duration_seconds: float


def summarize_run(
    explanations: list[RequestExplanation],
    plans: list[JourneyPlan],
    validation_issues: list[PlanValidationIssue],
    run_duration_seconds: float,
) -> RunSummary:
    """One summary of the whole batch: `explanations` covers every open request in it (module 6.7),
    `plans` is module 6.5's per-journey output, `validation_issues` is module 6.6's findings.
    """
    unmatched = [
        explanation
        for explanation in explanations
        if explanation.status not in (STATUS_MATCHED, STATUS_DROPPED_AFTER_SHARING)
    ]
    used_plans = [plan for plan in plans if plan.request_ids]

    return RunSummary(
        requested_count=len(explanations),
        matched_count=sum(1 for e in explanations if e.status == STATUS_MATCHED),
        dropped_after_sharing_count=sum(
            1 for e in explanations if e.status == STATUS_DROPPED_AFTER_SHARING
        ),
        unmatched_count=len(unmatched),
        unmatched_by_reason=dict(Counter(e.status for e in unmatched)),
        journeys_used=len(used_plans),
        total_distance_meters=sum(plan.total_distance_meters for plan in used_plans),
        total_duration_seconds=sum(plan.total_duration_seconds for plan in used_plans),
        validation_issue_count=len(validation_issues),
        run_duration_seconds=run_duration_seconds,
    )
