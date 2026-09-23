import type { TripRequestStatus } from '@ridemesh/types';
import {
  collection,
  doc,
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
  /** The request's own status (Module 7.2 onwards moves it through PICKUP_ASSIGNED, etc.); null if unreadable. */
  status: TripRequestStatus | null;
}

export type JourneyPlanStopsSnapshot =
  { status: 'none' } | { status: 'ready'; stops: JourneyPlanStop[] };

interface StopEntry {
  kind: 'pickup' | 'dropoff';
  requestId: string;
}

function isStopKind(value: unknown): value is 'pickup' | 'dropoff' {
  return value === 'pickup' || value === 'dropoff';
}

function parseStopEntries(rawStops: unknown): StopEntry[] {
  if (!Array.isArray(rawStops)) return [];
  return rawStops
    .map((entry: unknown): StopEntry | null => {
      if (typeof entry !== 'object' || entry === null) return null;
      const { kind, requestId } = entry as Record<string, unknown>;
      return isStopKind(kind) && typeof requestId === 'string' ? { kind, requestId } : null;
    })
    .filter((entry): entry is StopEntry => entry !== null);
}

/**
 * The stop order of the most recent plan for journey `journeyId` (Module 6.9); empty if there is
 * none. Filters on driverId as well as journeyId: Firestore's security rules for a `list` query must
 * hold for every document the query could possibly return, not just the ones actually returned, so
 * the query has to filter on the very field the rule checks (journeyPlans' own rule: driverId ==
 * request.auth.uid) or Firestore refuses the whole query with permission-denied - filtering only on
 * journeyId, which the rule does not check, is not enough even though every real result would pass.
 */
async function readStopEntries(
  client: Pick<FirebaseClient, 'firestore'>,
  journeyId: string,
  driverId: string,
): Promise<StopEntry[]> {
  const plans = await getDocs(
    query(
      collection(client.firestore, 'journeyPlans'),
      where('driverId', '==', driverId),
      where('journeyId', '==', journeyId),
      orderBy('createdAt', 'desc'),
      limit(1),
    ),
  );
  return parseStopEntries(plans.docs[0]?.get('stops'));
}

interface RequestFacts {
  passengerName: string;
  origin: string | null;
  destination: string | null;
  status: TripRequestStatus | null;
}

function readRequestFacts(data: Record<string, unknown> | undefined): RequestFacts {
  const origin = data?.origin as Record<string, unknown> | undefined;
  const destination = data?.destination as Record<string, unknown> | undefined;
  return {
    passengerName: typeof data?.passengerName === 'string' ? data.passengerName : 'Passenger',
    origin: typeof origin?.formattedAddress === 'string' ? origin.formattedAddress : null,
    destination:
      typeof destination?.formattedAddress === 'string' ? destination.formattedAddress : null,
    status: typeof data?.status === 'string' ? (data.status as TripRequestStatus) : null,
  };
}

function buildStops(entries: StopEntry[], facts: Map<string, RequestFacts>): JourneyPlanStop[] {
  return entries.map((entry) => {
    const request = facts.get(entry.requestId);
    return {
      kind: entry.kind,
      requestId: entry.requestId,
      passengerName: request?.passengerName ?? 'Passenger',
      address: request ? (entry.kind === 'pickup' ? request.origin : request.destination) : null,
      status: request?.status ?? null,
    };
  });
}

/**
 * Follows journey `journeyId`'s matchedTripRequestIds and, for each one, its own trip request live
 * (Module 7.2's driver actions change a request's status without touching the journey), rebuilding
 * the plan's stop order (Module 6.9's journeyPlans - read once per set of matched requests, since the
 * order itself never changes) whenever any of it changes. Returns an unsubscribe function, the same
 * shape as the other subscribeTo* helpers.
 */
export function subscribeToJourneyPlanStops(
  client: Pick<FirebaseClient, 'firestore'>,
  journeyId: string,
  onChange: (snapshot: JourneyPlanStopsSnapshot) => void,
  onError: (error: unknown) => void,
): () => void {
  let requestUnsubscribes: Array<() => void> = [];
  let stopEntries: StopEntry[] = [];
  const facts = new Map<string, RequestFacts>();
  let stopped = false;

  function emit(): void {
    if (stopEntries.length === 0) {
      onChange({ status: 'none' });
      return;
    }
    onChange({ status: 'ready', stops: buildStops(stopEntries, facts) });
  }

  function watchRequests(requestIds: string[]): void {
    for (const unsubscribe of requestUnsubscribes) unsubscribe();
    facts.clear();
    requestUnsubscribes = requestIds.map((requestId) =>
      onSnapshot(
        doc(client.firestore, 'tripRequests', requestId),
        (snapshot) => {
          facts.set(requestId, readRequestFacts(snapshot.data()));
          emit();
        },
        onError,
      ),
    );
  }

  const unsubscribeJourney = onSnapshot(
    doc(client.firestore, 'driverJourneys', journeyId),
    (snapshot) => {
      const matchedTripRequestIds = snapshot.get('matchedTripRequestIds');
      const requestIds = Array.isArray(matchedTripRequestIds)
        ? matchedTripRequestIds.filter((id): id is string => typeof id === 'string')
        : [];
      const driverId: unknown = snapshot.get('driverId');
      if (requestIds.length === 0 || typeof driverId !== 'string') {
        for (const unsubscribe of requestUnsubscribes) unsubscribe();
        requestUnsubscribes = [];
        stopEntries = [];
        onChange({ status: 'none' });
        return;
      }
      readStopEntries(client, journeyId, driverId)
        .then((entries) => {
          if (stopped) return;
          stopEntries = entries;
          watchRequests(requestIds);
        })
        .catch(onError);
    },
    onError,
  );

  return () => {
    stopped = true;
    unsubscribeJourney();
    for (const unsubscribe of requestUnsubscribes) unsubscribe();
  };
}
