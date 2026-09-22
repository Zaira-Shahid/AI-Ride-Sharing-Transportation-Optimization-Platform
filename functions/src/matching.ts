import type { Firestore } from 'firebase-admin/firestore';
import { distanceMeters } from './tripRequests.js';

// Candidate discovery (Module 5.2): a cheap, first-pass filter over AVAILABLE driver journeys
// (Module 5.1) for a trip request, before any route is calculated - Stage 1 of the spec's matching
// pipeline (section 15). It only looks at proximity, seats and a coarse direction check; route
// overlap, detour and walking distance (the spec's Stage 2) need calculateRoute (Module 4.3) and are
// left for a later module, as is anything that runs this automatically or acts on its result (a
// request stays exactly as it is today; nothing here writes to it yet).
//
// A driver has no schedule of their own (only ONLINE/OFFLINE), so this only makes sense for a
// request leaving NOW: matching a future-dated request against a driver who merely happens to be
// online right now is a later module's decision (driver scheduling, or a closer-to-departure
// re-check).

/** How close a journey's origin must be to the pickup to be a candidate, in metres. */
export const CANDIDATE_PROXIMITY_METERS = 5_000;

/** How far the journey's own heading may differ from the trip's, in degrees. */
export const CANDIDATE_DIRECTION_TOLERANCE_DEGREES = 45;

interface Point {
  latitude: number;
  longitude: number;
}

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
const toDegrees = (radians: number) => (radians * 180) / Math.PI;

/** The initial compass bearing from `a` to `b`, in degrees clockwise from north (0 up to 360). */
export function bearingDegrees(a: Point, b: Point): number {
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const deltaLongitude = toRadians(b.longitude - a.longitude);
  const y = Math.sin(deltaLongitude) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLongitude);
  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}

/** The smaller angle between two compass bearings: 0 (same direction) up to 180 (opposite). */
export function bearingDifferenceDegrees(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

/** The parts of an AVAILABLE journey candidate discovery needs. */
export interface CandidateSourceJourney {
  id: string;
  driverId: string;
  origin: Point | null;
  destination: Point | null;
  availableSeats: number | null;
}

/** The parts of a trip request candidate discovery needs. */
export interface CandidateSourceTrip {
  origin: Point;
  destination: Point;
}

/** A journey that passed the filter, closest first. */
export interface CandidateJourney {
  journeyId: string;
  driverId: string;
  distanceMeters: number;
  bearingDifferenceDegrees: number;
}

/**
 * Filters `journeys` (every AVAILABLE journey, however they were found) down to the ones that could
 * plausibly serve `trip`: at least one seat, an origin within CANDIDATE_PROXIMITY_METERS of the
 * pickup, and heading within CANDIDATE_DIRECTION_TOLERANCE_DEGREES of the trip's own direction. A
 * journey without an origin or a destination is skipped (Module 5.1 requires both before a journey
 * can become AVAILABLE, so this is only ever a defensive check). Sorted nearest first.
 */
export function findCandidateJourneys(
  trip: CandidateSourceTrip,
  journeys: readonly CandidateSourceJourney[],
): CandidateJourney[] {
  const tripBearing = bearingDegrees(trip.origin, trip.destination);
  const candidates: CandidateJourney[] = [];

  for (const journey of journeys) {
    if (!journey.origin || !journey.destination) continue;
    if (typeof journey.availableSeats !== 'number' || journey.availableSeats < 1) continue;

    const distance = distanceMeters(trip.origin, journey.origin);
    if (distance > CANDIDATE_PROXIMITY_METERS) continue;

    const journeyBearing = bearingDegrees(journey.origin, journey.destination);
    const bearingDiff = bearingDifferenceDegrees(tripBearing, journeyBearing);
    if (bearingDiff > CANDIDATE_DIRECTION_TOLERANCE_DEGREES) continue;

    candidates.push({
      journeyId: journey.id,
      driverId: journey.driverId,
      distanceMeters: distance,
      bearingDifferenceDegrees: bearingDiff,
    });
  }

  return candidates.sort((a, b) => a.distanceMeters - b.distanceMeters);
}

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function pointOf(value: unknown): Point | null {
  if (typeof value !== 'object' || value === null) return null;
  const { latitude, longitude } = value as Record<string, unknown>;
  return isNumber(latitude) && isNumber(longitude) ? { latitude, longitude } : null;
}

/**
 * Reads every AVAILABLE journey and returns `trip`'s candidates (findCandidateJourneys). Every
 * AVAILABLE journey is read: the pool is only ever the drivers online right now (Module 5.1), which
 * "start simple" (spec, Phase 5) accepts is small enough not to need a geospatial index yet.
 */
export async function findCandidateJourneysNow(
  deps: { firestore: Firestore },
  trip: CandidateSourceTrip,
): Promise<CandidateJourney[]> {
  const snapshot = await deps.firestore
    .collection('driverJourneys')
    .where('status', '==', 'AVAILABLE')
    .get();

  const journeys: CandidateSourceJourney[] = snapshot.docs.map((doc) => {
    const data = doc.data();
    const driverId: unknown = data.driverId;
    return {
      id: doc.id,
      driverId: typeof driverId === 'string' ? driverId : '',
      origin: pointOf(data.origin),
      destination: pointOf(data.destination),
      availableSeats: isNumber(data.availableSeats) ? data.availableSeats : null,
    };
  });

  return findCandidateJourneys(trip, journeys);
}

/**
 * Whether a trip request's chosen departure was "leave now": its requestedDepartureTime was set to
 * the same server instant as requestedAt (createTripRequest, Module 3.7), which never happens for a
 * chosen future time (it must be at least a few minutes ahead). Candidate discovery only makes sense
 * for these; see the note at the top of this file.
 */
export function isLeaveNowRequest(trip: {
  requestedAt: { toMillis(): number } | null | undefined;
  requestedDepartureTime: { toMillis(): number } | null | undefined;
}): boolean {
  return (
    trip.requestedAt != null &&
    trip.requestedDepartureTime != null &&
    trip.requestedAt.toMillis() === trip.requestedDepartureTime.toMillis()
  );
}
