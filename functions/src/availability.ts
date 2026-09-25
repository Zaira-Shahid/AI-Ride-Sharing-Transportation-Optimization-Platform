import {
  FieldValue,
  type DocumentSnapshot,
  type Firestore,
  type Transaction,
} from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { requireVerifiedDriver, type DriverCaller } from './callers.js';
import { createNotification } from './notifications.js';

// Functions deploy from this directory alone, so these mirror @ridemesh/types.
// tests/roles-parity.test.ts fails if they diverge.
export const AVAILABILITY_TARGETS = ['ONLINE', 'OFFLINE'] as const;
export const setAvailabilityInputSchema = z.object({ status: z.enum(AVAILABILITY_TARGETS) });
export const SET_AVAILABILITY_REFUSALS = ['PASSENGERS_ONBOARD'] as const;

// A matched request the driver has already picked up: going offline can never release these back to
// SEARCHING (Module 8.5, driver cancellation) - unlike one still only PICKUP_ASSIGNED/DRIVER_ARRIVING,
// there is no safe way to "unmatch" someone already in the vehicle.
const ONBOARD_TRIP_STATUSES = new Set(['PICKED_UP', 'IN_TRANSIT', 'DROPOFF_APPROACHING']);
// The only two statuses going offline may actually release: a request already COMPLETED or CANCELLED
// can still be sitting in matchedTripRequestIds (nothing trims it once done) and must be left alone.
const RELEASABLE_TRIP_STATUSES = new Set(['PICKUP_ASSIGNED', 'DRIVER_ARRIVING']);

export const GO_ONLINE_REQUIREMENTS = [
  'accountActive',
  'driverVerified',
  'vehicleAdded',
  'vehicleVerified',
  'seatsSet',
  'destinationDeclared',
  'originSet',
  'seatsOffered',
  'detourSet',
] as const;
export type GoOnlineRequirement = (typeof GO_ONLINE_REQUIREMENTS)[number];

export interface GoOnlineFacts {
  accountActive: boolean;
  driverStatus: unknown;
  /** Null when the driver has not added a vehicle. */
  vehicleStatus: unknown;
  seatCapacity: unknown;
  destinationDeclared: boolean;
  /** The driver has saved where the journey starts (Module 4.1). */
  originSet: boolean;
  /** Seats the driver offers on their open journey. */
  availableSeats: unknown;
  /** Extra minutes and kilometres the driver accepts on their open journey. */
  maxDetourMinutes: unknown;
  maxDetourDistance: unknown;
}

// The ranges are those of DETOUR_* in journeys.ts, repeated as numbers because journeys.ts imports
// vehicles.ts, which imports this file. tests/roles-parity.test.ts checks them.
function isWholeNumberBetween(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Whether a driver may go online: an ACTIVE account, a VERIFIED driver, a VERIFIED vehicle, its
 * passenger seats set, a destination declared and seats on offer chosen (at least one, never more
 * than the vehicle has) and both detour limits chosen. This is the check that is enforced; the app
 * shows the same list.
 */
export function evaluateGoOnline(facts: GoOnlineFacts): {
  eligible: boolean;
  unmet: GoOnlineRequirement[];
} {
  const hasVehicle = facts.vehicleStatus !== null && facts.vehicleStatus !== undefined;
  const met: Record<GoOnlineRequirement, boolean> = {
    accountActive: facts.accountActive,
    driverVerified: facts.driverStatus === 'VERIFIED',
    vehicleAdded: hasVehicle,
    vehicleVerified: facts.vehicleStatus === 'VERIFIED',
    seatsSet: hasVehicle && typeof facts.seatCapacity === 'number',
    destinationDeclared: facts.destinationDeclared,
    originSet: facts.originSet,
    // 1 is SEAT_CAPACITY_MIN; vehicles.ts imports this file, so it is not imported back here.
    seatsOffered:
      hasVehicle &&
      typeof facts.seatCapacity === 'number' &&
      typeof facts.availableSeats === 'number' &&
      Number.isInteger(facts.availableSeats) &&
      facts.availableSeats >= 1 &&
      facts.availableSeats <= facts.seatCapacity,
    detourSet:
      isWholeNumberBetween(facts.maxDetourMinutes, 1, 60) &&
      isWholeNumberBetween(facts.maxDetourDistance, 1, 30),
  };
  const unmet = GO_ONLINE_REQUIREMENTS.filter((requirement) => !met[requirement]);
  return { eligible: unmet.length === 0, unmet };
}

export type SetAvailabilityResult = { status: 'updated' | 'unchanged' };

/**
 * Lets a driver go online or offline. Going online needs every requirement in
 * evaluateGoOnline; going offline is always allowed. The driver never writes the document
 * themselves. Routine toggles are not audited (the time is kept in availabilityChangedAt); being
 * taken offline by the system is (see offlineFields).
 */
export async function setAvailability(
  deps: { firestore: Firestore },
  caller: DriverCaller,
  rawInput: unknown,
): Promise<SetAvailabilityResult> {
  requireVerifiedDriver(caller);

  const parsed = setAvailabilityInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'The availability is not valid.');
  }
  const { status } = parsed.data;

  const { firestore } = deps;
  const userRef = firestore.collection('users').doc(caller.uid);
  const driverRef = firestore.collection('drivers').doc(caller.uid);
  const vehicleRef = firestore.collection('vehicles').doc(caller.uid);

  return firestore.runTransaction(async (tx): Promise<SetAvailabilityResult> => {
    const [user, driver, vehicle] = await Promise.all([
      tx.get(userRef),
      tx.get(driverRef),
      tx.get(vehicleRef),
    ]);
    const ownJourney = await readOwnJourney(tx, firestore, caller.uid, driver);
    if (!user.exists || !driver.exists) {
      throw new HttpsError('failed-precondition', 'This account cannot change availability.');
    }
    if (driver.get('availabilityStatus') === status) return { status: 'unchanged' };

    if (status === 'ONLINE') {
      const { eligible, unmet } = evaluateGoOnline({
        accountActive: user.get('status') === 'ACTIVE',
        driverStatus: driver.get('verificationStatus'),
        vehicleStatus: vehicle.exists ? vehicle.get('verificationStatus') : null,
        seatCapacity: vehicle.exists ? vehicle.get('seatCapacity') : null,
        destinationDeclared: ownJourney?.get('destination') != null,
        originSet: ownJourney?.get('origin') != null,
        availableSeats: ownJourney?.get('availableSeats') ?? null,
        maxDetourMinutes: ownJourney?.get('maxDetourMinutes') ?? null,
        maxDetourDistance: ownJourney?.get('maxDetourDistance') ?? null,
      });
      if (!eligible) {
        throw new HttpsError('failed-precondition', 'You cannot go online yet.', { unmet });
      }
      // The journey becomes a candidate for matching (Module 5.1) the moment it is DRAFT and its
      // driver is online; going online with a journey already MATCHING or ACTIVE (matched earlier,
      // taken offline and back online) leaves it as it is.
      if (ownJourney?.get('status') === 'DRAFT') {
        tx.update(ownJourney.ref, { status: 'AVAILABLE', updatedAt: FieldValue.serverTimestamp() });
      }
    }

    // Module 8.5 (driver cancellation): a MATCHING/ACTIVE journey's own matched requests must be read
    // (before any write, per the transaction rule) to decide whether going offline is even allowed.
    let tripsToRelease: DocumentSnapshot[] = [];
    if (status === 'OFFLINE' && ownJourney) {
      const { onboard, releasable } = await readReleasableMatchedTrips(tx, firestore, ownJourney);
      if (onboard) {
        throw new HttpsError(
          'failed-precondition',
          'You have a passenger already in your vehicle. Complete their drop-off before going offline.',
          { reason: 'PASSENGERS_ONBOARD' },
        );
      }
      tripsToRelease = releasable;
    }

    if (status === 'OFFLINE' && ownJourney) {
      // Going offline ends the sharing of the driver's position: the last one is removed, so it does
      // not sit on the journey as if it were current. (When the system takes a driver offline, see
      // offlineFields, the last position stays until the driver next goes online; only the driver
      // and verified staff can read it, and docs/security.md lists this.)
      const journeyUpdate: Record<string, unknown> = {};
      if (ownJourney.get('currentLocation') != null) journeyUpdate.currentLocation = null;
      // Only a journey nobody has been matched to yet stops being a candidate this way; one already
      // MATCHING or ACTIVE (and known by now to have no onboard passenger) is cancelled here instead
      // (Module 8.5) - back to DRAFT, same as a routine offline toggle, so the driver can reuse the
      // same destination/seats/detour once they go online again.
      if (tripsToRelease.length > 0) {
        journeyUpdate.status = 'DRAFT';
        journeyUpdate.matchedTripRequestIds = [];
      } else {
        Object.assign(journeyUpdate, journeyOfflineFields(ownJourney));
      }
      if (Object.keys(journeyUpdate).length > 0) {
        tx.update(ownJourney.ref, { ...journeyUpdate, updatedAt: FieldValue.serverTimestamp() });
      }
      releaseMatchedTrips(
        tx,
        firestore,
        ownJourney,
        tripsToRelease,
        caller.uid,
        'Driver went offline before pickup',
      );
    }

    tx.update(driverRef, {
      availabilityStatus: status,
      availabilityChangedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { status: 'updated' };
  });
}

/**
 * Reads the driver's own open journey inside a transaction, from their own snapshot's
 * `currentJourneyId` - never one the pointer happens to lead to that belongs to someone else. Read
 * this before any write in the transaction (Firestore requires every read to happen first).
 */
export async function readOwnJourney(
  tx: Transaction,
  firestore: Firestore,
  driverId: string,
  driverSnapshot: DocumentSnapshot,
): Promise<DocumentSnapshot | undefined> {
  const journeyId: unknown = driverSnapshot.get('currentJourneyId');
  if (typeof journeyId !== 'string' || !journeyId) return undefined;
  const journey = await tx.get(firestore.collection('driverJourneys').doc(journeyId));
  return journey.exists && journey.get('driverId') === driverId ? journey : undefined;
}

/**
 * The field that takes a driver's journey off the matching pool when they are forced offline
 * (Module 5.1): AVAILABLE only, back to DRAFT. A journey already MATCHING or ACTIVE is left alone
 * here - what going offline mid-match should do is Module 5.6's decision, once matching exists.
 * Undefined when there is nothing to change. Use alongside offlineFields, with the driver's own
 * journey from readOwnJourney.
 */
export function journeyOfflineFields(
  journey: DocumentSnapshot | undefined,
): { status: 'DRAFT' } | undefined {
  if (!journey || journey.get('status') !== 'AVAILABLE') return undefined;
  return { status: 'DRAFT' };
}

/**
 * The fields that take a driver offline, or undefined when they are not online. Use it inside a
 * transaction, together with auditTakenOffline, when something a driver needs to be online (a
 * verified driver profile or vehicle) is lost. Reads must happen before any write.
 */
export function offlineFields(
  driver: DocumentSnapshot,
): { availabilityStatus: 'OFFLINE'; availabilityChangedAt: FieldValue } | undefined {
  if (!driver.exists || driver.get('availabilityStatus') !== 'ONLINE') return undefined;
  return { availabilityStatus: 'OFFLINE', availabilityChangedAt: FieldValue.serverTimestamp() };
}

export interface ReleasableMatchedTrips {
  /** Whether any matched request is already PICKED_UP or later - never safe to release. */
  onboard: boolean;
  /** Matched requests still only PICKUP_ASSIGNED/DRIVER_ARRIVING - safe to release to SEARCHING. */
  releasable: DocumentSnapshot[];
}

/**
 * Reads a journey's own matchedTripRequestIds and splits them (Module 8.5, driver cancellation): a
 * no-op (both empty) for any journey not MATCHING or ACTIVE, or when there is none. A request already
 * COMPLETED/CANCELLED but still lingering in the array (nothing trims it once done) counts as
 * neither. Read this before any write in the transaction.
 */
export async function readReleasableMatchedTrips(
  tx: Transaction,
  firestore: Firestore,
  journey: DocumentSnapshot | undefined,
): Promise<ReleasableMatchedTrips> {
  const journeyStatus = journey?.get('status');
  if (!journey || (journeyStatus !== 'MATCHING' && journeyStatus !== 'ACTIVE')) {
    return { onboard: false, releasable: [] };
  }
  const matchedIds = journey.get('matchedTripRequestIds');
  const ids = (Array.isArray(matchedIds) ? matchedIds : []).filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  );
  const snaps = await Promise.all(
    ids.map((id) => tx.get(firestore.collection('tripRequests').doc(id))),
  );
  return {
    onboard: snaps.some((snap) => snap.exists && ONBOARD_TRIP_STATUSES.has(snap.get('status'))),
    releasable: snaps.filter(
      (snap) => snap.exists && RELEASABLE_TRIP_STATUSES.has(snap.get('status')),
    ),
  };
}

/**
 * Writes the release of `releasable` requests back to SEARCHING, each with its own audit entry, plus
 * one audit entry for the journey itself if any were released (the journey's own DRAFT/
 * matchedTripRequestIds update is the caller's job, alongside whatever else it needs to write to the
 * same document - Module 8.5, driver cancellation, shared by the driver's own offline toggle
 * (availability.ts) and the system taking them offline (vehicles.ts, verification.ts). A no-op when
 * `releasable` is empty. All reads for this must already be done.
 */
export function releaseMatchedTrips(
  tx: Transaction,
  firestore: Firestore,
  journey: DocumentSnapshot,
  releasable: DocumentSnapshot[],
  actor: string,
  reason: string,
): void {
  for (const trip of releasable) {
    const previousStatus = trip.get('status');
    tx.update(trip.ref, {
      status: 'SEARCHING',
      matchedJourneyId: null,
      matchedDriverId: null,
      driverName: null,
      vehicleType: null,
      vehicleMake: null,
      vehicleModel: null,
      vehiclePlateNumber: null,
      driverLocation: null,
      assignedPlanId: null,
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.create(firestore.collection('auditLogs').doc(), {
      timestamp: FieldValue.serverTimestamp(),
      actor,
      action: 'TRIP_UNMATCHED_DRIVER_CANCELLED',
      entity: `tripRequests/${trip.id}`,
      previousState: { status: previousStatus },
      newState: { status: 'SEARCHING' },
      reason,
    });
    // Module 8.9 (notification): only when the recipient is readable (a real trip document always
    // has one - defensive only).
    const passengerId = trip.get('passengerId');
    if (typeof passengerId === 'string' && passengerId) {
      createNotification(tx, firestore, {
        recipientId: passengerId,
        type: 'RELEASED_TO_SEARCHING',
        message: 'Your driver is no longer available. We are looking for a new match for you.',
        relatedEntity: `tripRequests/${trip.id}`,
      });
    }
  }
  if (releasable.length > 0) {
    tx.create(firestore.collection('auditLogs').doc(), {
      timestamp: FieldValue.serverTimestamp(),
      actor,
      action: 'JOURNEY_CANCELLED_DRIVER_OFFLINE',
      entity: `driverJourneys/${journey.id}`,
      previousState: { status: journey.get('status') },
      newState: { status: 'DRAFT' },
      reason: `${releasable.length} matched passenger(s) not yet picked up were released`,
    });
  }
}

export function auditTakenOffline(
  tx: Transaction,
  firestore: Firestore,
  driverId: string,
  actor: string,
  reason: string,
): void {
  tx.create(firestore.collection('auditLogs').doc(), {
    timestamp: FieldValue.serverTimestamp(),
    actor,
    action: 'DRIVER_TAKEN_OFFLINE',
    entity: `drivers/${driverId}`,
    previousState: { availabilityStatus: 'ONLINE' },
    newState: { availabilityStatus: 'OFFLINE' },
    reason,
  });
}
