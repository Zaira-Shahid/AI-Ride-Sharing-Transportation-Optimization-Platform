import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';

// Phase 14 (Privacy compliance, spec section 56 "retention policies"). The policy docs/security.md
// has recorded since the trip request module: a request's exact places are deleted 30 days after it
// ends. Until this module nothing deleted anything.
//
// What is cleared, and what deliberately is not: the request's origin and destination (exact
// coordinates and addresses) and driverLocation (the matched driver's last exact position, left on
// the request after the trip) are set to null. The rest of the record stays - status, fare, payment
// fields, who - because fares, receipts, refunds and disputes still need it (the decision
// docs/security.md left open "with the payments module"). A cleared request is marked placesCleared
// so each one is cleared once and the sweep never looks at it again.
//
// Only requests that carry an endedAt are ever touched. endedAt is written when a request becomes
// COMPLETED or CANCELLED, so anything that ended before this module existed has none and is simply
// never selected: not retroactive, by design (a request with no end time cannot be aged honestly -
// updatedAt changes on every write).
//
// The audit entry names the request only, never a place (same stance as every trip audit entry).

export const TRIP_PLACES_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** How many requests one run clears at most; a backlog is simply worked off over the next runs. */
export const TRIP_RETENTION_BATCH_SIZE = 200;

export interface TripRetentionOutcome {
  checked: number;
  cleared: number;
}

export async function clearExpiredTripPlaces(
  deps: {
    firestore: Firestore;
    /** Always tripRequests in production; tests use their own collection so a run only sees its own fixtures. */
    collection?: string;
  },
  now: number = Date.now(),
): Promise<TripRetentionOutcome> {
  const { firestore } = deps;
  const collection = deps.collection ?? 'tripRequests';
  const cutoff = Timestamp.fromMillis(now - TRIP_PLACES_RETENTION_DAYS * DAY_MS);

  const expired = await firestore
    .collection(collection)
    .where('placesCleared', '==', false)
    .where('endedAt', '<=', cutoff)
    .orderBy('endedAt', 'asc')
    .limit(TRIP_RETENTION_BATCH_SIZE)
    .get();

  let cleared = 0;
  for (const snapshot of expired.docs) {
    const tripRef = snapshot.ref;
    const didClear = await firestore.runTransaction(async (tx) => {
      // Re-read inside the transaction: a concurrent run (or a request somehow reopened) must not
      // be cleared twice, nor cleared while it is no longer ended.
      const current = await tx.get(tripRef);
      const endedAt = current.get('endedAt') as Timestamp | null | undefined;
      const status: unknown = current.get('status');
      if (
        !current.exists ||
        current.get('placesCleared') === true ||
        !endedAt ||
        endedAt.toMillis() > cutoff.toMillis() ||
        (status !== 'COMPLETED' && status !== 'CANCELLED')
      ) {
        return false;
      }
      tx.update(tripRef, {
        origin: null,
        destination: null,
        driverLocation: null,
        placesCleared: true,
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.create(firestore.collection('auditLogs').doc(), {
        timestamp: FieldValue.serverTimestamp(),
        actor: 'system',
        action: 'TRIP_PLACES_CLEARED',
        entity: `${collection}/${tripRef.id}`,
        previousState: null,
        newState: { placesCleared: true },
        reason: `Retention: the exact places were removed ${TRIP_PLACES_RETENTION_DAYS} days after the request ended`,
      });
      return true;
    });
    if (didClear) cleared += 1;
  }

  return { checked: expired.size, cleared };
}
