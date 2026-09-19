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
] as const;
export type GoOnlineRequirement = (typeof GO_ONLINE_REQUIREMENTS)[number];

export interface GoOnlineFacts {
  accountActive: boolean;
  driverStatus: unknown;
  /** Null when the driver has not added a vehicle. */
  vehicleStatus: unknown;
  seatCapacity: unknown;
}

/**
 * Whether a driver may go online: an ACTIVE account, a VERIFIED driver, a VERIFIED vehicle and its
 * passenger seats set. This is the check that is enforced; the app shows the same list.
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
      });
      if (!eligible) {
        throw new HttpsError('failed-precondition', 'You cannot go online yet.', { unmet });
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
