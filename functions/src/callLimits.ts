import type { Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';

// Phase 14 (Security audit, module "rate limiting"): abuse/cost protection for mutating callables -
// distinct from lookupLimits.ts's own external-API-budget limiter (OSRM/Nominatim), which this reuses
// the same Firestore-backed sliding-window shape from (a per-key window/count counter, so it holds
// across function instances), just keyed per (scope, caller) instead of per external service.
//
// A caller over their own limit is refused outright with a 'resource-exhausted' HttpsError, unlike
// lookupLimits.ts's own claimLookup (which returns a boolean for calculateRoute/reverseGeocode to
// turn into a normal, retry-friendly "busy" result) - none of this file's own callers have an
// equivalent retry-friendly outcome shape, so refusing the call is the simpler, correct choice here.
//
// Numbers passed in by each call site are this project's own invented, generous-for-a-real-user
// ceilings (documented at each call site, not measured against real traffic - there is none yet),
// meant to catch a buggy or hostile client hammering an endpoint, not to shape normal usage.

export interface CallRateLimit {
  windowMs: number;
  maxCalls: number;
}

const COLLECTION = 'callLimits';

/**
 * Throws 'resource-exhausted' once `uid` has already made `limit.maxCalls` calls under `scope`
 * within the last `limit.windowMs`; otherwise records this call and returns normally. A call that
 * cannot be counted (the transaction fails under heavy load) is treated as OVER the limit - failing
 * closed is always the safe choice for a limiter, the same stance claimLookup already takes.
 */
export async function enforceCallRateLimit(
  firestore: Firestore,
  scope: string,
  uid: string,
  now: number,
  limit: CallRateLimit,
): Promise<void> {
  const ref = firestore.collection(COLLECTION).doc(`${scope}_${uid}`);
  const allowed = await firestore
    .runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      const windowStart = snapshot.get('windowStart');
      const count = snapshot.get('count');
      const sameWindow =
        typeof windowStart === 'number' &&
        typeof count === 'number' &&
        now - windowStart < limit.windowMs;
      if (sameWindow && count >= limit.maxCalls) return false;

      tx.set(ref, sameWindow ? { windowStart, count: count + 1 } : { windowStart: now, count: 1 });
      return true;
    })
    .catch(() => false);

  if (!allowed) {
    throw new HttpsError(
      'resource-exhausted',
      'Too many requests. Please slow down and try again.',
    );
  }
}
