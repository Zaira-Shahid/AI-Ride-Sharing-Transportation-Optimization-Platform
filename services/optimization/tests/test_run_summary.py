from app.explain import (
    STATUS_DROPPED_AFTER_SHARING,
    STATUS_MATCHED,
    STATUS_UNMATCHED_NO_NEARBY_JOURNEY,
    STATUS_UNMATCHED_NO_SEAT,
    RequestExplanation,
)
from app.plan import JourneyPlan
from app.plan_validation import PlanValidationIssue
from app.run_summary import summarize_run


def explanation(request_id: str, status: str, journey_id: str | None = None) -> RequestExplanation:
    return RequestExplanation(request_id, status, journey_id, "reason")


def plan(journey_id: str, request_ids: list[str], distance: float = 0) -> JourneyPlan:
    return JourneyPlan(
        journey_id=journey_id,
        driver_id="driver-1",
        stops=[],
        request_ids=request_ids,
        dropped_request_ids=[],
        total_distance_meters=distance,
        total_duration_seconds=distance,
    )


def test_summarizes_an_empty_run() -> None:
    summary = summarize_run([], [], [], run_duration_seconds=0.5)

    assert summary.requested_count == 0
    assert summary.matched_count == 0
    assert summary.dropped_after_sharing_count == 0
    assert summary.unmatched_count == 0
    assert summary.unmatched_by_reason == {}
    assert summary.journeys_used == 0
    assert summary.total_distance_meters == 0
    assert summary.validation_issue_count == 0
    assert summary.run_duration_seconds == 0.5


def test_counts_matched_dropped_and_unmatched_requests_separately() -> None:
    explanations = [
        explanation("r1", STATUS_MATCHED, "j1"),
        explanation("r2", STATUS_MATCHED, "j1"),
        explanation("r3", STATUS_DROPPED_AFTER_SHARING, "j2"),
        explanation("r4", STATUS_UNMATCHED_NO_SEAT),
        explanation("r5", STATUS_UNMATCHED_NO_NEARBY_JOURNEY),
    ]

    summary = summarize_run(explanations, [], [], run_duration_seconds=1.0)

    assert summary.requested_count == 5
    assert summary.matched_count == 2
    assert summary.dropped_after_sharing_count == 1
    assert summary.unmatched_count == 2
    assert summary.unmatched_by_reason == {
        STATUS_UNMATCHED_NO_SEAT: 1,
        STATUS_UNMATCHED_NO_NEARBY_JOURNEY: 1,
    }


def test_counts_only_journeys_that_actually_kept_a_request() -> None:
    plans = [plan("j1", ["r1"], distance=1000), plan("j2", [], distance=0)]

    summary = summarize_run([], plans, [], run_duration_seconds=1.0)

    assert summary.journeys_used == 1
    assert summary.total_distance_meters == 1000


def test_reports_the_number_of_validation_issues_found() -> None:
    issues = [
        PlanValidationIssue(journey_id="j1", reason="over capacity"),
        PlanValidationIssue(journey_id="j2", reason="malformed stops"),
    ]

    summary = summarize_run([], [], issues, run_duration_seconds=1.0)

    assert summary.validation_issue_count == 2
