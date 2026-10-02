import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';

// Phase 14 (Privacy compliance, spec section 56 "retention policies"). The policy docs/security.md has
// recorded since the trip request module: a request's exact places are deleted 30 days after it ends.
// The same rule now covers a driver's journey: its start and end points and last position are
// cleared 30 days after it ends, so a driver gets the same treatment without having to delete their
// account.
//
// What is cleared, and what deliberately is not. For a trip request: origin and destination (exact
// coordinates and addresses) and driverLocation (the matched driver's last exact position, left on the
// request after the trip) are set to null. For a driver journey: origin, destination and
// currentLocation. The rest of the record stays - status, fare, payment fields, who, a journey's
// matched requests and its driver - because fares, receipts, refunds and disputes still need a trip
// request, and a journey is still the driver's own (only account deletion unlinks it). A cleared
// record is marked placesCleared so each one is cleared once and the sweep never looks at it again.
//
// Only records that carry an endedAt are ever touched. endedAt is written when a request becomes
// COMPLETED or CANCELLED, and when a journey becomes COMPLETED (the one place a journey ends), so
// anything that ended before this module existed has none and is simply never selected: not
// retroactive, by design (a record with no end time cannot be aged honestly - updatedAt changes on
// every write). A journey that never ended (a DRAFT the driver went offline from and kept) has no
// endedAt either, and is not covered: the same as an open trip request, and it is replaced when the
// driver declares a new destination.
//
// The audit entry names the record only, never a place (same stance as every trip audit entry).

export const TRIP_PLACES_RETENTION_DAYS = 30;
/** The same policy for a driver's journey. */
export const JOURNEY_PLACES_RETENTION_DAYS = TRIP_PLACES_RETENTION_DAYS;
const DAY_MS = 24 * 60 * 60 * 1000;

/** How many records one run clears at most; a backlog is simply worked off over the next runs. */
export const TRIP_RETENTION_BATCH_SIZE = 200;

export interface TripRetentionOutcome {
  checked: number;
  cleared: number;
}

interface PlacesRetention {
  /** What a test's own collection is called, or the real one. */
  collection: string;
  retentionDays: number;
  /** A record is only cleared once it is in one of these statuses (it may have been reopened). */
  endedStatuses: readonly string[];
  /** The exact places to set to null. */
  clearedFields: readonly string[];
  auditAction: string;
  /** For the audit reason, e.g. "request" or "journey". */
  noun: string;
}

async function clearExpiredPlaces(
  firestore: Firestore,
  rule: PlacesRetention,
  now: number,
): Promise<TripRetentionOutcome> {
  const cutoff = Timestamp.fromMillis(now - rule.retentionDays * DAY_MS);

  const expired = await firestore
    .collection(rule.collection)
    .where('placesCleared', '==', false)
    .where('endedAt', '<=', cutoff)
    .orderBy('endedAt', 'asc')
    .limit(TRIP_RETENTION_BATCH_SIZE)
    .get();

  const cleared = Object.fromEntries(rule.clearedFields.map((field) => [field, null]));
  let clearedCount = 0;
  for (const snapshot of expired.docs) {
    const ref = snapshot.ref;
    const didClear = await firestore.runTransaction(async (tx) => {
      // Re-read inside the transaction: a concurrent run (or a record somehow reopened) must not be
      // cleared twice, nor cleared while it is no longer ended.
      const current = await tx.get(ref);
      const endedAt = current.get('endedAt') as Timestamp | null | undefined;
      const status: unknown = current.get('status');
      if (
        !current.exists ||
        current.get('placesCleared') === true ||
        !endedAt ||
        endedAt.toMillis() > cutoff.toMillis() ||
        typeof status !== 'string' ||
        !rule.endedStatuses.includes(status)
      ) {
        return false;
      }
      tx.update(ref, {
        ...cleared,
        placesCleared: true,
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.create(firestore.collection('auditLogs').doc(), {
        timestamp: FieldValue.serverTimestamp(),
        actor: 'system',
        action: rule.auditAction,
        entity: `${rule.collection}/${ref.id}`,
        previousState: null,
        newState: { placesCleared: true },
        reason: `Retention: the exact places were removed ${rule.retentionDays} days after the ${rule.noun} ended`,
      });
      return true;
    });
    if (didClear) clearedCount += 1;
  }

  return { checked: expired.size, cleared: clearedCount };
}

export function clearExpiredTripPlaces(
  deps: {
    firestore: Firestore;
    /** Always tripRequests in production; tests use their own collection so a run only sees its own fixtures. */
    collection?: string;
  },
  now: number = Date.now(),
): Promise<TripRetentionOutcome> {
  return clearExpiredPlaces(
    deps.firestore,
    {
      collection: deps.collection ?? 'tripRequests',
      retentionDays: TRIP_PLACES_RETENTION_DAYS,
      endedStatuses: ['COMPLETED', 'CANCELLED'],
      clearedFields: ['origin', 'destination', 'driverLocation'],
      auditAction: 'TRIP_PLACES_CLEARED',
      noun: 'request',
    },
    now,
  );
}

export function clearExpiredJourneyPlaces(
  deps: {
    firestore: Firestore;
    /** Always driverJourneys in production; tests use their own collection so a run only sees its own fixtures. */
    collection?: string;
  },
  now: number = Date.now(),
): Promise<TripRetentionOutcome> {
  return clearExpiredPlaces(
    deps.firestore,
    {
      collection: deps.collection ?? 'driverJourneys',
      retentionDays: JOURNEY_PLACES_RETENTION_DAYS,
      endedStatuses: ['COMPLETED', 'CANCELLED'],
      clearedFields: ['origin', 'destination', 'currentLocation'],
      auditAction: 'JOURNEY_PLACES_CLEARED',
      noun: 'journey',
    },
    now,
  );
}
