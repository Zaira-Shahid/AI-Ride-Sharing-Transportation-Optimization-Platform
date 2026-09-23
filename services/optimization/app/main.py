"""The optimization service's HTTP app (Module 6.0, foundation; endpoints wired in Module 6.9).

Runs on Cloud Run, next to (not part of) the Firebase project: Cloud Functions call it over HTTPS
the way they already call OSRM and Nominatim (functions/src/routing.ts, geocoding.ts), rather than
running OR-Tools in the Functions process itself.

Two endpoints, split by the real routing dependency between them (this service never calls a
routing server itself): `/candidates` runs module 6.1's cheap proximity/direction filter, no routing
needed. Cloud Functions then computes a real route cost for each candidate pair AND a distance/
duration matrix for every journey any candidate belongs to, and calls `/optimize`, which runs
modules 6.2 through 6.8 (constraints, assignment, plan generation, validation, explanations, run
summary) in one response.
"""

import time

from fastapi import FastAPI

from app.candidates import Candidate, generate_candidates
from app.constraints import filter_feasible_candidates
from app.explain import explain_requests
from app.model import solve_assignment
from app.plan import generate_plan
from app.plan_validation import validate_plans
from app.run_summary import summarize_run
from app.schemas import (
    CandidateModel,
    CandidatesRequest,
    CandidatesResponse,
    JourneyPlanModel,
    OptimizeRequest,
    OptimizeResponse,
    PlanValidationIssueModel,
    RequestExplanationModel,
    RunSummaryModel,
    StopModel,
    request_detour_limits_from_cost,
)

app = FastAPI(title="RideMesh Optimization Service")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "ridemesh-optimization"}


@app.post("/candidates")
def candidates_endpoint(body: CandidatesRequest) -> CandidatesResponse:
    candidates = generate_candidates(
        requests=[request.to_input() for request in body.requests],
        journeys=[journey.to_input() for journey in body.journeys],
    )
    return CandidatesResponse(candidates=[CandidateModel.from_candidate(c) for c in candidates])


@app.post("/optimize")
def optimize_endpoint(body: OptimizeRequest) -> OptimizeResponse:
    started_at = time.perf_counter()

    costs = [cost.to_cost() for cost in body.costs]
    feasible = filter_feasible_candidates(costs)
    assignments = solve_assignment(feasible, body.available_seats)

    request_ids_by_journey: dict[str, list[str]] = {}
    for assignment in assignments:
        request_ids_by_journey.setdefault(assignment.journey_id, []).append(assignment.request_id)

    limits_by_request = {cost.request_id: request_detour_limits_from_cost(cost) for cost in costs}

    plans = [
        generate_plan(
            journey_id=journey_id,
            driver_id=next(a.driver_id for a in assignments if a.journey_id == journey_id),
            request_ids=request_ids,
            limits={request_id: limits_by_request[request_id] for request_id in request_ids},
            matrix=body.matrices[journey_id].to_matrix(),
        )
        for journey_id, request_ids in request_ids_by_journey.items()
    ]

    validation_issues = validate_plans(plans, body.available_seats)

    pseudo_candidates = [
        Candidate(
            request_id=cost.request_id,
            journey_id=cost.journey_id,
            driver_id=cost.driver_id,
            distance_meters=0.0,
            bearing_difference_degrees=0.0,
        )
        for cost in costs
    ]
    explanations = explain_requests(body.request_ids, pseudo_candidates, feasible, plans)

    run_duration_seconds = time.perf_counter() - started_at
    summary = summarize_run(explanations, plans, validation_issues, run_duration_seconds)

    return OptimizeResponse(
        plans=[
            JourneyPlanModel(
                journey_id=plan.journey_id,
                driver_id=plan.driver_id,
                stops=[StopModel.from_stop(stop) for stop in plan.stops],
                request_ids=plan.request_ids,
                dropped_request_ids=plan.dropped_request_ids,
                total_distance_meters=plan.total_distance_meters,
                total_duration_seconds=plan.total_duration_seconds,
            )
            for plan in plans
        ],
        explanations=[RequestExplanationModel.from_explanation(e) for e in explanations],
        validation_issues=[PlanValidationIssueModel.from_issue(i) for i in validation_issues],
        summary=RunSummaryModel.from_summary(summary),
    )
