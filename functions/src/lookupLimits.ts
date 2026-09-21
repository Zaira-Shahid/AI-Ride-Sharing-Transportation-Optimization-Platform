import type { Firestore } from 'firebase-admin/firestore';

// Protects a public service we ask on people's behalf (Nominatim for addresses, OSRM for routes): its
// usage policy allows about one request a second, and one person should not use them all. Shared by
// reverse geocoding and route calculation, each with its own counters.

export interface LookupLimits {
  /** The least time between two requests from all callers together. */
  globalSpacingMs: number;
  /** How many requests (not answered from the cache) one caller may cause in a minute. */
  perCallerPerMinute: number;
}

/** The Firestore collections one service keeps its counters in (server-only; closed to clients). */
export interface LookupCollections {
  perCaller: string;
  global: string;
}

const WINDOW_MS = 60_000;

/**
 * Takes a place in line to ask the provider, or says there is none: the provider gets at most one
 * request every globalSpacingMs from everybody together, and one caller at most perCallerPerMinute
 * in a minute. Both counters are in Firestore, so they hold across function instances. A caller
 * that cannot be counted (the transaction fails under heavy load) should be treated as busy.
 */
export async function claimLookup(
  firestore: Firestore,
  collections: LookupCollections,
  uid: string,
  now: number,
  limits: LookupLimits,
): Promise<boolean> {
  const callerRef = firestore.collection(collections.perCaller).doc(uid);
  const globalRef = firestore.collection(collections.global).doc('lookups');
  return firestore.runTransaction(async (tx) => {
    const [caller, global] = await Promise.all([tx.get(callerRef), tx.get(globalRef)]);
    const lastAt = global.get('lastAt');
    if (typeof lastAt === 'number' && now - lastAt < limits.globalSpacingMs) return false;

    const windowStart = caller.get('windowStart');
    const count = caller.get('count');
    const sameWindow =
      typeof windowStart === 'number' && typeof count === 'number' && now - windowStart < WINDOW_MS;
    if (sameWindow && count >= limits.perCallerPerMinute) return false;

    tx.set(
      callerRef,
      sameWindow ? { windowStart, count: count + 1 } : { windowStart: now, count: 1 },
    );
    tx.set(globalRef, { lastAt: now });
    return true;
  });
}
