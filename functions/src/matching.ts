import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import type { LookupLimits } from './lookupLimits.js';
import { calculateRoute, type RoutePoint, type RoutingProvider } from './routing.js';
import { distanceMeters } from './tripRequests.js';

// Candidate discovery (Module 5.2) and starting the search (Module 5.3). Candidate discovery is a
// cheap, first-pass filter over AVAILABLE driver journeys (Module 5.1) for a trip request, before
// any route is calculated - Stage 1 of the spec's matching pipeline (section 15). It only looks at
// proximity, seats and a coarse direction check; route overlap, detour and walking distance (the
// spec's Stage 2) need calculateRoute (Module 4.3) and are left for a later module, as is anything
// that assigns a match.
//
// A driver has no schedule of their own (only ONLINE/OFFLINE), so discovery only makes sense for a
// request leaving NOW. A Firestore trigger (matchTripRequestOnCreate, index.ts) moves every new
// request from REQUESTED to SEARCHING: for a leave-now one, only after running discovery; a
// future-dated one is moved straight to SEARCHING with no discovery run, and waits there until a
// later module adds driver scheduling or a closer-to-departure re-check.

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

export type MatchOutcome = 'skipped' | 'queued' | 'searching';

/**
 * Starts the search for trip request `tripId`, if it still needs one: only a REQUESTED request does
 * (safe to run more than once - a trigger can be delivered twice, and a request already SEARCHING or
 * past it, or gone, or cancelled in the meantime, is left alone). A leave-now request runs candidate
 * discovery first and stores how many it found (candidateCount: 0 or more - a snapshot for a person
 * to read, not a list to assign from; whoever assigns a match asks again, against the pool as it is
 * then, since a driver can go offline in the meantime); a future-dated one skips discovery and goes
 * straight to SEARCHING with no count, see the note at the top of this file.
 */
export async function matchTripRequest(
  deps: {
    firestore: Firestore;
    /** Always tripRequests in production; tests use another collection so the trigger does not race them. */
    collection?: string;
  },
  tripId: string,
): Promise<MatchOutcome> {
  const { firestore } = deps;
  const tripRef = firestore.collection(deps.collection ?? 'tripRequests').doc(tripId);

  const trip = await tripRef.get();
  if (!trip.exists || trip.get('status') !== 'REQUESTED') return 'skipped';
  // A real request always has this (createTripRequest sets it); a document without one was never
  // made through the real function (a fixture written directly for another test, say) and is left
  // alone.
  if (trip.get('requestedAt') == null) return 'skipped';

  const leaveNow = isLeaveNowRequest({
    requestedAt: trip.get('requestedAt'),
    requestedDepartureTime: trip.get('requestedDepartureTime'),
  });

  let candidateCount: number | null = null;
  if (leaveNow) {
    const origin = pointOf(trip.get('origin'));
    const destination = pointOf(trip.get('destination'));
    if (origin && destination) {
      candidateCount = (await findCandidateJourneysNow({ firestore }, { origin, destination }))
        .length;
    }
  }

  return firestore.runTransaction(async (tx): Promise<MatchOutcome> => {
    const current = await tx.get(tripRef);
    if (!current.exists || current.get('status') !== 'REQUESTED') return 'skipped';
    tx.update(tripRef, {
      status: 'SEARCHING',
      ...(candidateCount === null ? {} : { candidateCount }),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return leaveNow ? 'searching' : 'queued';
  });
}

// Route compatibility (Module 5.4): Stage 2 of the spec's matching pipeline (section 15), for one
// candidate from Stage 1 (findCandidateJourneys) at a time. It asks calculateRoute (Module 4.3) for
// the driver's own route, and the same route with the passenger's pickup and destination inserted
// before the driver's destination - a fixed insertion, not a search for the best order or the best
// drop-off point (no last-mile walking yet: the passenger is always taken to their exact
// destination). The difference between the two routes must fit both the driver's detour limits
// (Module 2.8) and the passenger's own flexibility preferences (Module 3.6); the tighter of the two
// always decides. Like Stage 1, this is untriggered: nothing calls it automatically, and nothing is
// assigned from its result - that is a later module's decision.

export interface RouteCompatibilityLimits {
  driverMaxDetourMinutes: number;
  driverMaxDetourDistanceKm: number;
  passengerMaxExtraMinutes: number;
  passengerMaxDetourDistanceKm: number;
}

export interface RouteCompatibilityResult {
  compatible: boolean;
  additionalDistanceMeters: number;
  additionalDurationSeconds: number;
}

/**
 * Whether the difference between a driver's own route (`base`) and the same route with a
 * passenger's pickup and destination inserted (`withPassenger`) fits inside both the driver's
 * detour limits and the passenger's flexibility preferences. A route can come back very slightly
 * shorter than its own base route (OSRM rounds each independently), so a negative difference counts
 * as none, not a credit.
 */
export function checkRouteCompatibility(
  base: { distanceMeters: number; durationSeconds: number },
  withPassenger: { distanceMeters: number; durationSeconds: number },
  limits: RouteCompatibilityLimits,
): RouteCompatibilityResult {
  const additionalDistanceMeters = Math.max(0, withPassenger.distanceMeters - base.distanceMeters);
  const additionalDurationSeconds = Math.max(
    0,
    withPassenger.durationSeconds - base.durationSeconds,
  );
  const additionalDistanceKm = additionalDistanceMeters / 1000;
  const additionalMinutes = additionalDurationSeconds / 60;

  const compatible =
    additionalDistanceKm <= limits.driverMaxDetourDistanceKm &&
    additionalMinutes <= limits.driverMaxDetourMinutes &&
    additionalDistanceKm <= limits.passengerMaxDetourDistanceKm &&
    additionalMinutes <= limits.passengerMaxExtraMinutes;

  return { compatible, additionalDistanceMeters, additionalDurationSeconds };
}

/**
 * The stops for a candidate's route with a passenger's pickup and destination inserted before the
 * driver's own destination, in that order: a fixed, simple insertion (no search for a better order
 * or a shared drop-off point - that is full optimization, Phase 6).
 */
export function candidateRouteStops(
  driverOrigin: RoutePoint,
  passengerPickup: RoutePoint,
  passengerDestination: RoutePoint,
  driverDestination: RoutePoint,
): RoutePoint[] {
  return [driverOrigin, passengerPickup, passengerDestination, driverDestination];
}

export type RouteCompatibilityOutcome =
  ({ status: 'checked' } & RouteCompatibilityResult) | { status: 'unavailable' };

/**
 * Works out whether one candidate journey can take one trip request without going over anyone's
 * detour limits: the driver's own route, and the same route with the passenger inserted
 * (candidateRouteStops), both asked for through calculateRoute (Module 4.3, so both go through its
 * cache, rounding and limits). 'unavailable' when either route could not be had (no road route, the
 * routing server down or busy) - never thrown, so one bad candidate never stops the others being
 * checked next.
 */
export async function checkCandidateRoute(
  deps: {
    firestore: Firestore;
    provider: RoutingProvider;
    limits?: LookupLimits;
    now?: () => number;
  },
  input: {
    driverId: string;
    passengerId: string;
    driverOrigin: RoutePoint;
    driverDestination: RoutePoint;
    passengerPickup: RoutePoint;
    passengerDestination: RoutePoint;
  } & RouteCompatibilityLimits,
): Promise<RouteCompatibilityOutcome> {
  const { firestore, provider } = deps;
  const routeDeps = {
    firestore,
    provider,
    ...(deps.limits ? { limits: deps.limits } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  };
  const driverCaller = { uid: input.driverId, role: 'DRIVER', emailVerified: true };
  const passengerCaller = { uid: input.passengerId, role: 'PASSENGER', emailVerified: true };

  // One after the other, never together: both share the one global spacing limit (routeGlobal,
  // Module 4.3), which is meant to space consecutive calls apart, not referee concurrent ones.
  const baseResult = await calculateRoute(routeDeps, driverCaller, {
    stops: [input.driverOrigin, input.driverDestination],
  });
  if (baseResult.status !== 'found' || !baseResult.route) return { status: 'unavailable' };

  const withPassengerResult = await calculateRoute(routeDeps, passengerCaller, {
    stops: candidateRouteStops(
      input.driverOrigin,
      input.passengerPickup,
      input.passengerDestination,
      input.driverDestination,
    ),
  });
  if (withPassengerResult.status !== 'found' || !withPassengerResult.route) {
    return { status: 'unavailable' };
  }

  return {
    status: 'checked',
    ...checkRouteCompatibility(baseResult.route, withPassengerResult.route, {
      driverMaxDetourMinutes: input.driverMaxDetourMinutes,
      driverMaxDetourDistanceKm: input.driverMaxDetourDistanceKm,
      passengerMaxExtraMinutes: input.passengerMaxExtraMinutes,
      passengerMaxDetourDistanceKm: input.passengerMaxDetourDistanceKm,
    }),
  };
}

// Assignment (Module 5.5): the last stage of "basic matching" (spec Phase 5's acceptance line, "the
// system can automatically match simple shared trips") - picking one AVAILABLE journey for a
// SEARCHING, leave-now request that found candidates (Module 5.3), fully automatically (no driver
// accept step; every AVAILABLE journey counts as opted in - a driver preference to opt out is a
// later module, once there is a reason to add one). It is wired into the same trigger as starting
// the search (matchTripRequestOnCreate, index.ts): once a request has candidates, assignment runs
// right after. Only one passenger per journey for now ("simple" trips): a journey stops being a
// candidate the moment it is MATCHING (Module 5.2 only ever looks at AVAILABLE ones), so stacking
// several passengers onto one shared route is full optimization, Phase 6.

/** How many of Stage 1's closest candidates get a route check (Stage 2) before assigning. */
export const ASSIGN_CANDIDATES_CHECKED = 5;

/**
 * The candidate that adds the least distance to its driver's route, ties broken by the least added
 * time; null when there are none. The "cost" a candidate adds to the system is what decides, not
 * anything about the passenger (spec section 35: pricing must not drive matching, and neither does
 * anything else about who is asking).
 */
export function rankCandidates<
  T extends { additionalDistanceMeters: number; additionalDurationSeconds: number },
>(candidates: readonly T[]): T | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort(
    (a, b) =>
      a.additionalDistanceMeters - b.additionalDistanceMeters ||
      a.additionalDurationSeconds - b.additionalDurationSeconds,
  )[0]!;
}

export type AssignOutcome = 'skipped' | 'matched' | 'unmatched';

/**
 * Tries to assign one AVAILABLE journey to trip request `tripId`, if it still needs one: only a
 * SEARCHING request with candidates (candidateCount > 0, Module 5.3) and no assignment yet does.
 * Re-runs candidate discovery fresh (Module 5.2 - the pool may have moved on since the request
 * started searching), checks route compatibility (Module 5.4) for its closest ASSIGN_CANDIDATES_
 * CHECKED, and assigns whichever passes and adds the least distance (rankCandidates). 'unmatched'
 * when nobody passes: the request stays SEARCHING, unchanged, for a later module to retry (there is
 * no automatic re-check yet). A candidate that stops being AVAILABLE between being checked and being
 * assigned (taken by another request, or its driver going offline) is caught by the assigning
 * transaction; this attempt then also reports 'unmatched' rather than trying the next candidate -
 * accepted as a known gap while matching is still simple.
 */
export async function assignSearchingTripRequest(
  deps: {
    firestore: Firestore;
    provider: RoutingProvider;
    limits?: LookupLimits;
    now?: () => number;
    /** Always tripRequests in production; tests use another collection so the trigger does not race them. */
    collection?: string;
  },
  tripId: string,
): Promise<AssignOutcome> {
  const { firestore } = deps;
  const tripRef = firestore.collection(deps.collection ?? 'tripRequests').doc(tripId);

  const trip = await tripRef.get();
  if (!trip.exists || trip.get('status') !== 'SEARCHING' || trip.get('matchedJourneyId') != null) {
    return 'skipped';
  }
  const candidateCount = trip.get('candidateCount');
  if (typeof candidateCount !== 'number' || candidateCount < 1) return 'skipped';

  const origin = pointOf(trip.get('origin'));
  const destination = pointOf(trip.get('destination'));
  const passengerId: unknown = trip.get('passengerId');
  const preferences = trip.get('passengerPreferences') as
    { maxExtraTime?: unknown; maxDetourDistance?: unknown } | undefined;
  if (
    !origin ||
    !destination ||
    typeof passengerId !== 'string' ||
    !passengerId ||
    typeof preferences?.maxExtraTime !== 'number' ||
    typeof preferences?.maxDetourDistance !== 'number'
  ) {
    return 'skipped';
  }
  const passengerMaxExtraMinutes = preferences.maxExtraTime;
  const passengerMaxDetourDistanceKm = preferences.maxDetourDistance;

  const candidates = (await findCandidateJourneysNow({ firestore }, { origin, destination })).slice(
    0,
    ASSIGN_CANDIDATES_CHECKED,
  );

  const compatible: Array<
    CandidateJourney &
      Pick<RouteCompatibilityResult, 'additionalDistanceMeters' | 'additionalDurationSeconds'>
  > = [];
  for (const candidate of candidates) {
    const journeySnapshot = await firestore
      .collection('driverJourneys')
      .doc(candidate.journeyId)
      .get();
    const driverOrigin = pointOf(journeySnapshot.get('origin'));
    const driverDestination = pointOf(journeySnapshot.get('destination'));
    const driverMaxDetourMinutes = journeySnapshot.get('maxDetourMinutes');
    const driverMaxDetourDistanceKm = journeySnapshot.get('maxDetourDistance');
    if (
      !driverOrigin ||
      !driverDestination ||
      typeof driverMaxDetourMinutes !== 'number' ||
      typeof driverMaxDetourDistanceKm !== 'number'
    ) {
      continue;
    }

    // One after the other, never in parallel across candidates either: see checkCandidateRoute.
    const result = await checkCandidateRoute(
      {
        firestore,
        provider: deps.provider,
        ...(deps.limits ? { limits: deps.limits } : {}),
        ...(deps.now ? { now: deps.now } : {}),
      },
      {
        driverId: candidate.driverId,
        passengerId,
        driverOrigin,
        driverDestination,
        passengerPickup: origin,
        passengerDestination: destination,
        driverMaxDetourMinutes,
        driverMaxDetourDistanceKm,
        passengerMaxExtraMinutes,
        passengerMaxDetourDistanceKm,
      },
    );
    if (result.status === 'checked' && result.compatible) {
      compatible.push({
        ...candidate,
        additionalDistanceMeters: result.additionalDistanceMeters,
        additionalDurationSeconds: result.additionalDurationSeconds,
      });
    }
  }

  const winner = rankCandidates(compatible);
  if (!winner) return 'unmatched';

  const journeyRef = firestore.collection('driverJourneys').doc(winner.journeyId);
  return firestore.runTransaction(async (tx): Promise<AssignOutcome> => {
    const [currentTrip, currentJourney] = await Promise.all([tx.get(tripRef), tx.get(journeyRef)]);
    if (
      !currentTrip.exists ||
      currentTrip.get('status') !== 'SEARCHING' ||
      currentTrip.get('matchedJourneyId') != null
    ) {
      return 'skipped';
    }
    if (
      !currentJourney.exists ||
      currentJourney.get('status') !== 'AVAILABLE' ||
      currentJourney.get('driverId') !== winner.driverId
    ) {
      return 'unmatched';
    }

    tx.update(tripRef, {
      status: 'MATCHED',
      matchedJourneyId: winner.journeyId,
      matchedDriverId: winner.driverId,
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.update(journeyRef, {
      status: 'MATCHING',
      matchedTripRequestId: tripId,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return 'matched';
  });
}
