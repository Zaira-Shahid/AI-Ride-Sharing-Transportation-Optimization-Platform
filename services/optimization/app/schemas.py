"""Request/response shapes for the HTTP endpoints (module 6.9, wiring): the JSON boundary between
Cloud Functions and this service's pure pipeline (modules 6.1-6.8). Converts to and from the plain
dataclasses those modules already work with.

Two endpoints, not one, because of a real dependency the Python service can't cross on its own (it
never calls a routing server itself, per every earlier module's own decision): `/candidates` runs
module 6.1's cheap proximity/direction filter, which needs no routing. Cloud Functions then computes
a real route cost (existing calculateRoute) for each candidate pair `/candidates` returned, AND a
distance/duration matrix for every journey any of those candidates belongs to (needed in case that
journey ends up carrying more than one passenger) - and calls `/optimize` with all of that, which
runs modules 6.2 through 6.8 in one response.
"""

from __future__ import annotations

from pydantic import BaseModel

from app.candidates import Candidate, JourneyInput, TripRequestInput
from app.constraints import CandidateRouteCost
from app.explain import RequestExplanation
from app.geo import Point
from app.plan import RequestDetourLimits, RouteLeg, RouteMatrix, Stop
from app.plan_validation import PlanValidationIssue
from app.run_summary import RunSummary


class PointModel(BaseModel):
    latitude: float
    longitude: float

    def to_point(self) -> Point:
        return Point(latitude=self.latitude, longitude=self.longitude)


class TripRequestModel(BaseModel):
    id: str
    origin: PointModel
    destination: PointModel

    def to_input(self) -> TripRequestInput:
        return TripRequestInput(
            id=self.id, origin=self.origin.to_point(), destination=self.destination.to_point()
        )


class JourneyModel(BaseModel):
    id: str
    driver_id: str
    origin: PointModel | None = None
    destination: PointModel | None = None
    available_seats: int | None = None

    def to_input(self) -> JourneyInput:
        return JourneyInput(
            id=self.id,
            driver_id=self.driver_id,
            origin=self.origin.to_point() if self.origin else None,
            destination=self.destination.to_point() if self.destination else None,
            available_seats=self.available_seats,
        )


class CandidatesRequest(BaseModel):
    requests: list[TripRequestModel]
    journeys: list[JourneyModel]


class CandidateModel(BaseModel):
    request_id: str
    journey_id: str
    driver_id: str
    distance_meters: float
    bearing_difference_degrees: float

    @staticmethod
    def from_candidate(candidate: Candidate) -> CandidateModel:
        return CandidateModel(
            request_id=candidate.request_id,
            journey_id=candidate.journey_id,
            driver_id=candidate.driver_id,
            distance_meters=candidate.distance_meters,
            bearing_difference_degrees=candidate.bearing_difference_degrees,
        )

    def to_candidate(self) -> Candidate:
        return Candidate(
            request_id=self.request_id,
            journey_id=self.journey_id,
            driver_id=self.driver_id,
            distance_meters=self.distance_meters,
            bearing_difference_degrees=self.bearing_difference_degrees,
        )


class CandidatesResponse(BaseModel):
    candidates: list[CandidateModel]


class CandidateRouteCostModel(BaseModel):
    request_id: str
    journey_id: str
    driver_id: str
    additional_distance_meters: float
    additional_duration_seconds: float
    driver_max_detour_minutes: float
    driver_max_detour_distance_km: float
    passenger_max_extra_minutes: float
    passenger_max_detour_distance_km: float

    def to_cost(self) -> CandidateRouteCost:
        return CandidateRouteCost(**self.model_dump())


class RouteLegModel(BaseModel):
    from_stop: str
    to_stop: str
    distance_meters: float
    duration_seconds: float


class RouteMatrixModel(BaseModel):
    legs: list[RouteLegModel]

    def to_matrix(self) -> RouteMatrix:
        return RouteMatrix(
            legs={
                (leg.from_stop, leg.to_stop): RouteLeg(
                    distance_meters=leg.distance_meters, duration_seconds=leg.duration_seconds
                )
                for leg in self.legs
            }
        )


class OptimizeRequest(BaseModel):
    request_ids: list[str]
    costs: list[CandidateRouteCostModel]
    available_seats: dict[str, int]
    matrices: dict[str, RouteMatrixModel]


class StopModel(BaseModel):
    kind: str
    request_id: str

    @staticmethod
    def from_stop(stop: Stop) -> StopModel:
        return StopModel(kind=stop.kind, request_id=stop.request_id)


class JourneyPlanModel(BaseModel):
    journey_id: str
    driver_id: str
    stops: list[StopModel]
    request_ids: list[str]
    dropped_request_ids: list[str]
    total_distance_meters: float
    total_duration_seconds: float


class RequestExplanationModel(BaseModel):
    request_id: str
    status: str
    journey_id: str | None
    reason: str

    @staticmethod
    def from_explanation(explanation: RequestExplanation) -> RequestExplanationModel:
        return RequestExplanationModel(
            request_id=explanation.request_id,
            status=explanation.status,
            journey_id=explanation.journey_id,
            reason=explanation.reason,
        )


class PlanValidationIssueModel(BaseModel):
    journey_id: str
    reason: str

    @staticmethod
    def from_issue(issue: PlanValidationIssue) -> PlanValidationIssueModel:
        return PlanValidationIssueModel(journey_id=issue.journey_id, reason=issue.reason)


class RunSummaryModel(BaseModel):
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

    @staticmethod
    def from_summary(summary: RunSummary) -> RunSummaryModel:
        return RunSummaryModel(**summary.__dict__)


class OptimizeResponse(BaseModel):
    plans: list[JourneyPlanModel]
    explanations: list[RequestExplanationModel]
    validation_issues: list[PlanValidationIssueModel]
    summary: RunSummaryModel


def request_detour_limits_from_cost(cost: CandidateRouteCost) -> RequestDetourLimits:
    return RequestDetourLimits(
        request_id=cost.request_id,
        driver_max_detour_minutes=cost.driver_max_detour_minutes,
        driver_max_detour_distance_km=cost.driver_max_detour_distance_km,
        passenger_max_extra_minutes=cost.passenger_max_extra_minutes,
        passenger_max_detour_distance_km=cost.passenger_max_detour_distance_km,
    )
