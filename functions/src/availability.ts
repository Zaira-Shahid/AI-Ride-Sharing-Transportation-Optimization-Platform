import {
  FieldValue,
  type DocumentSnapshot,
  type Firestore,
  type Transaction,
} from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { requireVerifiedDriver, type DriverCaller } from './callers.js';

// Functions deploy from this directory alone, so these mirror @ridemesh/types.
// tests/roles-parity.test.ts fails if they diverge.
export const AVAILABILITY_TARGETS = ['ONLINE', 'OFFLINE'] as const;
export const setAvailabilityInputSchema = z.object({ status: z.enum(AVAILABILITY_TARGETS) });

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
    const journeyId: unknown = driver.get('currentJourneyId');
    const journey =
      typeof journeyId === 'string' && journeyId
        ? await tx.get(firestore.collection('driverJourneys').doc(journeyId))
        : undefined;
    if (!user.exists || !driver.exists) {
      throw new HttpsError('failed-precondition', 'This account cannot change availability.');
    }
    if (driver.get('availabilityStatus') === status) return { status: 'unchanged' };

    if (status === 'ONLINE') {
      // Only the driver's own journey counts, never one the pointer happens to lead to.
      const ownJourney =
        journey?.exists === true && journey.get('driverId') === caller.uid ? journey : undefined;
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
    }

    // Going offline ends the sharing of the driver's position: the last one is removed, so it does
    // not sit on the journey as if it were current. (When the system takes a driver offline, see
    // offlineFields, the last position stays until the driver next goes online; only the driver
    // and verified staff can read it, and docs/security.md lists this.)
    if (
      status === 'OFFLINE' &&
      journey?.exists === true &&
      journey.get('driverId') === caller.uid
    ) {
      if (journey.get('currentLocation') != null) {
        tx.update(journey.ref, { currentLocation: null, updatedAt: FieldValue.serverTimestamp() });
      }
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
