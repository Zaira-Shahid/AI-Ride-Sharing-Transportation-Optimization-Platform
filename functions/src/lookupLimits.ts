import type { DocumentReference, Firestore } from 'firebase-admin/firestore';

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
 * The slots booked by reserveLookupSlot: one document per slot, in a subcollection of the global
 * counter, so that clearing the counter's collection clears them too.
 */
const slotsOf = (firestore: Firestore, collections: LookupCollections) =>
  firestore.collection(collections.global).doc('lookups').collection('slots');

const SLOT_CLEANUP_EVERY = 25;
const SLOT_KEPT_MS = 10 * 60_000;

/**
 * Takes a place in line to ask the provider, or says there is none: the provider gets at most one
 * request every globalSpacingMs from everybody together, and one caller at most perCallerPerMinute
 * in a minute. Both counters are in Firestore, so they hold across function instances. A caller
 * that cannot be counted (the transaction fails under heavy load) should be treated as busy. It also
 * keeps clear of any slot booked by reserveLookupSlot, so the two ways in never ask the provider
 * within globalSpacingMs of each other.
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
    // A booked slot within one spacing of now (before or after) means the provider is spoken for.
    const spacing = limits.globalSpacingMs;
    const slotRefs: DocumentReference[] = [];
    if (spacing > 0) {
      const slots = slotsOf(firestore, collections);
      const from = Math.floor((now - spacing) / spacing) + 1;
      const to = Math.ceil((now + spacing) / spacing) - 1;
      for (let i = from; i <= to; i += 1) slotRefs.push(slots.doc(String(i)));
    }
    const [caller, global, ...booked] = await Promise.all([
      tx.get(callerRef),
      tx.get(globalRef),
      ...slotRefs.map((ref) => tx.get(ref)),
    ]);
    if (booked.some((slot) => slot.exists)) return false;
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

const isAlreadyExists = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 6 || code === 'already-exists';
};

/**
 * Like claimLookup, but a caller who arrives while the provider is being used books a place in line
 * instead of being refused, and is told how long to wait for it. The line is a row of slots
 * globalSpacingMs apart (slot n is the moment n * globalSpacingMs); booking one is creating its
 * document, which either succeeds or fails at once because somebody else has it, and then the next
 * slot is tried. Callers therefore never queue behind each other on a lock, which is what one shared
 * counter document did when 50 of them came together (the load test: lock timeouts, most of a burst
 * given up on). The provider is asked exactly as politely as before.
 *
 * Returns the wait in milliseconds (0 when the provider is free now), or null when the caller has
 * used up their minute, or the first free slot is more than maxWaitMs away (the line is too long to
 * wait in). A caller that cannot be counted should be treated as busy, as for claimLookup. One
 * known small gap: lastAt (set by claimLookup) is read once, before booking, so a claimLookup landing
 * between that read and the booking can end up closer than the spacing to this caller's lookup.
 */
export async function reserveLookupSlot(
  firestore: Firestore,
  collections: LookupCollections,
  uid: string,
  now: number,
  limits: LookupLimits,
  maxWaitMs: number,
): Promise<number | null> {
  const callerRef = firestore.collection(collections.perCaller).doc(uid);
  // The caller's own minute is counted first, on a document of their own (no contention), so a caller
  // who is over their limit never takes a slot.
  const allowed = await firestore.runTransaction(async (tx) => {
    const caller = await tx.get(callerRef);
    const windowStart = caller.get('windowStart');
    const count = caller.get('count');
    const sameWindow =
      typeof windowStart === 'number' && typeof count === 'number' && now - windowStart < WINDOW_MS;
    if (sameWindow && count >= limits.perCallerPerMinute) return false;
    tx.set(
      callerRef,
      sameWindow ? { windowStart, count: count + 1 } : { windowStart: now, count: 1 },
    );
    return true;
  });
  if (!allowed) return null;

  const spacing = limits.globalSpacingMs;
  if (spacing <= 0) return 0;

  const lastAt = (await firestore.collection(collections.global).doc('lookups').get()).get(
    'lastAt',
  );
  const slots = slotsOf(firestore, collections);
  const first = Math.max(
    Math.ceil(now / spacing),
    typeof lastAt === 'number' ? Math.ceil((lastAt + spacing) / spacing) : 0,
  );
  const last = Math.floor((now + maxWaitMs) / spacing);
  for (let index = first; index <= last; index += 1) {
    try {
      await slots.doc(String(index)).create({ at: index * spacing });
    } catch (error) {
      if (isAlreadyExists(error)) continue;
      throw error;
    }
    if (index % SLOT_CLEANUP_EVERY === 0) {
      // Old slots are never read again; clear a few now and then. Best effort.
      void slots
        .where('at', '<', now - SLOT_KEPT_MS)
        .limit(SLOT_CLEANUP_EVERY)
        .get()
        .then((old) => Promise.all(old.docs.map((slot) => slot.ref.delete())))
        .catch(() => undefined);
    }
    return index * spacing - now;
  }
  return null;
}
