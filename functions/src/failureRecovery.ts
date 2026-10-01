import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { matchTripRequest } from './matching.js';
import type { OptimizationServiceConfig } from './optimizationClient.js';
import { voidStaleAuthorization } from './paymentVoid.js';
import type { PushProvider } from './pushProvider.js';
import { reoptimizeDelayedJourney } from './routeModification.js';
import type { RoutingProvider } from './routing.js';
import type { StripeProvider } from './stripeProvider.js';

// Phase 14 (Failure recovery). A security-audit-adjacent finding: three one-shot Cloud Function
// triggers elsewhere in this codebase fire only on a STATUS TRANSITION, with nothing else watching
// the state that transition left behind if its one attempt fails - matchTripRequestOnCreate
// (REQUESTED -> SEARCHING, index.ts), routeModificationOnDelay (a MATCHING journey newly flagged
// delayed), voidStaleAuthorizationOnRelease (a trip released back to SEARCHING/CANCELLED while still
// AUTHORIZED). Unlike a SEARCHING trip request (already re-swept every 2 minutes by
// batchOptimizationRun) or the Stripe webhook (Stripe itself retries a non-2xx response for days),
// none of these three had an equivalent backstop before this module - a transient failure at exactly
// the wrong moment left the affected trip/journey stuck with only a log line, not an error anyone
// would see or anything that would try again.
//
// Each sweep below reuses the SAME idempotent function its own real-time trigger already calls
// (matchTripRequest/reoptimizeDelayedJourney/voidStaleAuthorization all safely no-op on state that no
// longer needs them - see each one's own doc comment), so a sweep can never do anything the real-time
// path itself would not also have done; it only gives a failed attempt another chance.
//
// Thresholds and cadences below are this project's own invented, generous numbers - there is no real
// traffic yet to measure against - long enough that a normal, successful case is never touched by a
// sweep at all, short enough that a genuinely stuck case does not sit for hours.

const STUCK_REQUESTED_THRESHOLD_MS = 5 * 60_000;

export interface RequestedSweepOutcome {
  checked: number;
  started: number;
}

/**
 * Retries matchTripRequest for every REQUESTED trip request older than
 * STUCK_REQUESTED_THRESHOLD_MS - the backstop matchTripRequestOnCreate's own doc comment always
 * claimed existed ("a request that stays SEARCHING is normal, the trigger can be retried"), but did
 * not: nothing else ever re-checks a request that never left REQUESTED (batchOptimizationRun only
 * re-sweeps SEARCHING ones). Safe to run repeatedly and safe on a request whose real-time trigger is
 * simply still in flight: matchTripRequest itself only ever acts on a request still REQUESTED, and
 * the age threshold keeps a sweep from ever racing a normal, still-in-progress first attempt.
 */
export async function retryStuckRequestedTrips(
  deps: { firestore: Firestore },
  now: number = Date.now(),
): Promise<RequestedSweepOutcome> {
  const cutoff = Timestamp.fromMillis(now - STUCK_REQUESTED_THRESHOLD_MS);
  const snapshot = await deps.firestore
    .collection('tripRequests')
    .where('status', '==', 'REQUESTED')
    .where('createdAt', '<=', cutoff)
    .get();

  let started = 0;
  for (const doc of snapshot.docs) {
    const outcome = await matchTripRequest(deps, doc.id);
    if (outcome !== 'skipped') started += 1;
  }
  return { checked: snapshot.size, started };
}

export interface DelayedJourneySweepOutcome {
  checked: number;
  reoptimized: number;
}

/**
 * Retries reoptimizeDelayedJourney for every MATCHING journey still flagged delayed. Its own trigger
 * (routeModificationOnDelay) fires only on the transition into being delayed - a driver who stays
 * delayed on every later location update never re-triggers it again, since `before` is never null a
 * second time (locations.ts recomputes and rewrites the delay field on every update while the driver
 * stays behind pace, not only on change). If that one attempt failed - the optimization service
 * briefly unavailable, say - the journey stayed flagged and un-reoptimized until the driver
 * independently caught up on their own, exactly the case this feature exists for. Safe to run
 * repeatedly: reoptimizeDelayedJourney itself only ever acts on a journey still MATCHING and still
 * flagged, and clears the flag itself the moment it succeeds.
 */
export async function retryDelayedJourneys(deps: {
  firestore: Firestore;
  provider: RoutingProvider;
  optimizationService: OptimizationServiceConfig;
  push: PushProvider;
}): Promise<DelayedJourneySweepOutcome> {
  const snapshot = await deps.firestore
    .collection('driverJourneys')
    .where('status', '==', 'MATCHING')
    .get();

  let checked = 0;
  let reoptimized = 0;
  for (const doc of snapshot.docs) {
    if (doc.get('delay') == null) continue;
    checked += 1;
    const outcome = await reoptimizeDelayedJourney(deps, doc.id);
    if (outcome === 'reoptimized') reoptimized += 1;
  }
  return { checked, reoptimized };
}

const STALE_HOLD_THRESHOLD_MS = 10 * 60_000;
const RELEASED_PAYMENT_STATUSES = new Set(['SEARCHING', 'CANCELLED']);

export interface StaleHoldSweepOutcome {
  checked: number;
  voided: number;
}

/**
 * Retries voidStaleAuthorization for every trip released back to SEARCHING/CANCELLED more than
 * STALE_HOLD_THRESHOLD_MS ago while still AUTHORIZED. voidStaleAuthorization's own doc comment
 * already names a real fallback for a failed void - Stripe's own hold expiry after about a week - so
 * this is not a "never resolved" gap the way the other two sweeps close; it exists to free a
 * passenger's card hold within minutes instead of leaving it to that week-long expiry. Safe to run
 * repeatedly: voidStaleAuthorization itself only ever acts on a trip still AUTHORIZED and still
 * released.
 */
export async function retryStaleAuthorizedHolds(
  deps: { firestore: Firestore; stripe: StripeProvider },
  now: number = Date.now(),
): Promise<StaleHoldSweepOutcome> {
  const cutoff = now - STALE_HOLD_THRESHOLD_MS;
  const snapshot = await deps.firestore
    .collection('tripRequests')
    .where('paymentStatus', '==', 'AUTHORIZED')
    .get();

  let checked = 0;
  let voided = 0;
  for (const doc of snapshot.docs) {
    if (!RELEASED_PAYMENT_STATUSES.has(doc.get('status'))) continue;
    const updatedAt: unknown = doc.get('updatedAt');
    if (!(updatedAt instanceof Timestamp) || updatedAt.toMillis() > cutoff) continue;

    checked += 1;
    const outcome = await voidStaleAuthorization(deps, doc.id);
    if (outcome === 'voided') voided += 1;
  }
  return { checked, voided };
}
