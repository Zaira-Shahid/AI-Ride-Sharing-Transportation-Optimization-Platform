"""Candidate generation (Module 6.1): a cheap, first-pass filter over every open trip request and
every AVAILABLE driver journey in one batch, before any route is calculated - the same proximity,
seats and coarse-direction check as candidate discovery on the TypeScript side (Module 5.2,
functions/src/matching.ts's findCandidateJourneys), generalised from "one request against every
journey" to "every request against every journey", since batch optimisation (Module 6.3 onwards)
needs to see every plausible request/journey pairing at once, not just one request's own best match.

This is deliberately just the cheap filter, same as 5.2: which pairs are even worth asking the
constraint engine and the OR-Tools model about. It does not decide who actually shares a route with
whom - route overlap and detour (needs a real route) and the optimisation itself are later modules.
Pure and untriggered: nothing calls this over HTTP yet.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.geo import Point, bearing_degrees, bearing_difference_degrees, distance_meters

# Same values as Module 5.2 (functions/src/matching.ts), for the two to agree.
CANDIDATE_PROXIMITY_METERS = 5_000
CANDIDATE_DIRECTION_TOLERANCE_DEGREES = 45


@dataclass(frozen=True)
class TripRequestInput:
    id: str
    origin: Point
    destination: Point


@dataclass(frozen=True)
class JourneyInput:
    id: str
    driver_id: str
    origin: Point | None
    destination: Point | None
    available_seats: int | None


@dataclass(frozen=True)
class Candidate:
    request_id: str
    journey_id: str
    driver_id: str
    distance_meters: float
    bearing_difference_degrees: float


def generate_candidates(
    requests: list[TripRequestInput], journeys: list[JourneyInput]
) -> list[Candidate]:
    """Every (request, journey) pair that passes the cheap filter, nearest first. A journey without
    an origin or a destination, or with no seats left, is skipped entirely (Module 5.1 requires
    both, and at least one seat, before a journey can become AVAILABLE, so this is only ever a
    defensive check, same as on the TypeScript side).
    """
    candidates: list[Candidate] = []

    for journey in journeys:
        if journey.origin is None or journey.destination is None:
            continue
        if journey.available_seats is None or journey.available_seats < 1:
            continue
        journey_bearing = bearing_degrees(journey.origin, journey.destination)

        for request in requests:
            distance = distance_meters(request.origin, journey.origin)
            if distance > CANDIDATE_PROXIMITY_METERS:
                continue

            request_bearing = bearing_degrees(request.origin, request.destination)
            bearing_diff = bearing_difference_degrees(request_bearing, journey_bearing)
            if bearing_diff > CANDIDATE_DIRECTION_TOLERANCE_DEGREES:
                continue

            candidates.append(
                Candidate(
                    request_id=request.id,
                    journey_id=journey.id,
                    driver_id=journey.driver_id,
                    distance_meters=distance,
                    bearing_difference_degrees=bearing_diff,
                )
            )

    return sorted(candidates, key=lambda c: (c.distance_meters, c.journey_id, c.request_id))
