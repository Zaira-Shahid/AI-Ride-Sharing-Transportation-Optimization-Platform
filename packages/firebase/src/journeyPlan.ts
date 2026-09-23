import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
} from 'firebase/firestore';
import type { FirebaseClient } from './client';

/** One stop of a matched journey's plan (Module 6.9's stop order), with what the driver needs to see. */
export interface JourneyPlanStop {
  kind: 'pickup' | 'dropoff';
  requestId: string;
  /** The passenger's first name only (Module 7.1); 'Passenger' if the request could not be read. */
  passengerName: string;
  /** The pickup or destination address, matching `kind`; null if it could not be read. */
  address: string | null;
}

export type JourneyPlanStopsSnapshot =
  { status: 'none' } | { status: 'ready'; stops: JourneyPlanStop[] };

function isStopKind(value: unknown): value is 'pickup' | 'dropoff' {
  return value === 'pickup' || value === 'dropoff';
}

/**
 * Reads the stops of the most recent plan for journey `journeyId` (Module 6.9's journeyPlans), each
 * filled in with the passenger's first name and the matching address from their own trip request -
 * both readable by the matched driver only (Module 7.1's Firestore rules). One-shot: a plan's stops
 * do not change after it is written (no re-planning yet), so this is read once per plan rather than
 * kept live.
 */
export async function getJourneyPlanStops(
  client: Pick<FirebaseClient, 'firestore'>,
  journeyId: string,
): Promise<JourneyPlanStopsSnapshot> {
  const plans = await getDocs(
    query(
      collection(client.firestore, 'journeyPlans'),
      where('journeyId', '==', journeyId),
      orderBy('createdAt', 'desc'),
      limit(1),
    ),
  );
  const plan = plans.docs[0];
  if (!plan) return { status: 'none' };

  const rawStops = plan.get('stops');
  const stopEntries: Array<{ kind: 'pickup' | 'dropoff'; requestId: string }> = Array.isArray(
    rawStops,
  )
    ? rawStops
        .map((entry: unknown) => {
          if (typeof entry !== 'object' || entry === null) return null;
          const { kind, requestId } = entry as Record<string, unknown>;
          return isStopKind(kind) && typeof requestId === 'string' ? { kind, requestId } : null;
        })
        .filter(
          (entry): entry is { kind: 'pickup' | 'dropoff'; requestId: string } => entry !== null,
        )
    : [];

  const requestIds = [...new Set(stopEntries.map((entry) => entry.requestId))];
  const requests = new Map<
    string,
    { passengerName: string; origin: string | null; destination: string | null }
  >();
  await Promise.all(
    requestIds.map(async (requestId) => {
      const snapshot = await getDoc(doc(client.firestore, 'tripRequests', requestId));
      const data = snapshot.data();
      requests.set(requestId, {
        passengerName: typeof data?.passengerName === 'string' ? data.passengerName : 'Passenger',
        origin:
          typeof data?.origin === 'object' &&
          data.origin &&
          typeof data.origin.formattedAddress === 'string'
            ? (data.origin.formattedAddress as string)
            : null,
        destination:
          typeof data?.destination === 'object' &&
          data.destination &&
          typeof data.destination.formattedAddress === 'string'
            ? (data.destination.formattedAddress as string)
            : null,
      });
    }),
  );

  const stops: JourneyPlanStop[] = stopEntries.map((entry) => {
    const request = requests.get(entry.requestId);
    return {
      kind: entry.kind,
      requestId: entry.requestId,
      passengerName: request?.passengerName ?? 'Passenger',
      address: request ? (entry.kind === 'pickup' ? request.origin : request.destination) : null,
    };
  });

  return { status: 'ready', stops };
}

/**
 * Follows journey `journeyId`'s matchedTripRequestIds (through subscribeToJourney's own data) and,
 * whenever it changes, re-reads the plan's stops (getJourneyPlanStops). Returns an unsubscribe
 * function, the same shape as the other subscribeTo* helpers, even though the read itself is one-shot
 * per change rather than a live document listener (see getJourneyPlanStops).
 */
export function subscribeToJourneyPlanStops(
  client: Pick<FirebaseClient, 'firestore'>,
  journeyId: string,
  onChange: (snapshot: JourneyPlanStopsSnapshot) => void,
  onError: (error: unknown) => void,
): () => void {
  return onSnapshot(
    doc(client.firestore, 'driverJourneys', journeyId),
    (snapshot) => {
      const matchedTripRequestIds = snapshot.get('matchedTripRequestIds');
      if (!Array.isArray(matchedTripRequestIds) || matchedTripRequestIds.length === 0) {
        onChange({ status: 'none' });
        return;
      }
      getJourneyPlanStops(client, journeyId).then(onChange).catch(onError);
    },
    onError,
  );
}
