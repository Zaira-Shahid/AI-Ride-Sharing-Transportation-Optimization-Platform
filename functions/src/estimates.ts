import { FieldValue, type DocumentSnapshot, type Firestore } from 'firebase-admin/firestore';
import type { LookupLimits } from './lookupLimits.js';
import { calculateRoute, type RoutingProvider } from './routing.js';
import { OPEN_TRIP_STATUSES } from './tripRequests.js';

// The estimate of a trip request (Modules 4.4 and 4.5): the road distance in METRES and time in whole
// SECONDS from the pickup to the destination, worked out just after the request is created and
// written into estimatedDistance and estimatedDuration. It is done by a Firestore trigger, after the
// fact, so creating a request never waits for, or fails because of, the routing server. It is the
// one route lookup for the request: the app asked for the same route (same rounded stops) when it
// showed the passenger the estimate before they confirmed, so this normally comes from the cache.
// docs/architecture.md ("Trip estimate") has the whole picture.

export type EstimateOutcome = 'estimated' | 'skipped' | 'unavailable';

/** When the routing server is busy (its limits), wait a little longer than its spacing and try again. */
export const ESTIMATE_BUSY_WAIT_MS = 1_300;
export const ESTIMATE_BUSY_ATTEMPTS = 4;

const isOpen = (status: unknown) => (OPEN_TRIP_STATUSES as readonly unknown[]).includes(status);

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function pointOf(value: unknown): { latitude: number; longitude: number } | null {
  if (typeof value !== 'object' || value === null) return null;
  const { latitude, longitude } = value as Record<string, unknown>;
  return isNumber(latitude) && isNumber(longitude) ? { latitude, longitude } : null;
}

/** Whether a request still needs an estimate: it is open and has neither half of one. */
function needsEstimate(trip: DocumentSnapshot): boolean {
  return (
    trip.exists &&
    isOpen(trip.get('status')) &&
    trip.get('estimatedDistance') == null &&
    trip.get('estimatedDuration') == null
  );
}

/**
 * Works out the estimate of trip request `tripId` and writes it, if it still needs one. Safe to run
 * more than once (a trigger can be delivered twice): a request that already has an estimate, is gone
 * or is no longer open (cancelled, say, while the route was being found) is left alone.
 *
 * The route is asked for as the request's passenger, so it counts against their limits like any
 * other route they cause, and the stops go through the same rounding (about 11 m) and the same cache
 * as any route (docs/security.md, "Route calculation"). Nothing about the places is logged. When the
 * route cannot be had (no road route, the server down or busy for good) nothing is written, and the
 * app says the estimate is not available once it has waited long enough (ESTIMATE_WAIT_MS).
 */
export async function estimateTripRequest(
  deps: {
    firestore: Firestore;
    provider: RoutingProvider;
    limits?: LookupLimits;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    /**
     * Where the requests are. Always tripRequests in production; the tests use another collection for
     * the requests they make by hand, so that the trigger (which listens to tripRequests) does not
     * also work on them and race the test.
     */
    collection?: string;
  },
  tripId: string,
): Promise<EstimateOutcome> {
  const { firestore } = deps;
  const tripRef = firestore.collection(deps.collection ?? 'tripRequests').doc(tripId);

  const trip = await tripRef.get();
  if (!needsEstimate(trip)) return 'skipped';
  const passengerId: unknown = trip.get('passengerId');
  const origin = pointOf(trip.get('origin'));
  const destination = pointOf(trip.get('destination'));
  if (typeof passengerId !== 'string' || !passengerId || !origin || !destination) return 'skipped';

  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const caller = { uid: passengerId, role: 'PASSENGER', emailVerified: true };
  const input = { stops: [origin, destination] };
  const routeDeps = {
    firestore,
    provider: deps.provider,
    ...(deps.limits ? { limits: deps.limits } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  };

  let result = await calculateRoute(routeDeps, caller, input).catch(() => null);
  for (
    let attempt = 1;
    result?.status === 'busy' && attempt < ESTIMATE_BUSY_ATTEMPTS;
    attempt += 1
  ) {
    await sleep(ESTIMATE_BUSY_WAIT_MS);
    result = await calculateRoute(routeDeps, caller, input).catch(() => null);
  }
  if (result?.status !== 'found' || !result.route) return 'unavailable';
  const { distanceMeters, durationSeconds } = result.route;

  return firestore.runTransaction(async (tx): Promise<EstimateOutcome> => {
    const current = await tx.get(tripRef);
    if (!needsEstimate(current)) return 'skipped';
    tx.update(tripRef, {
      estimatedDistance: distanceMeters,
      estimatedDuration: durationSeconds,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return 'estimated';
  });
}
