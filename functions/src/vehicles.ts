import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';

// Functions deploy from this directory alone, so these mirror @ridemesh/types.
// tests/roles-parity.test.ts fails if they diverge.
export const VEHICLE_TYPES = ['CAR', 'VAN', 'MINIBUS'] as const;
export const NEW_VEHICLE_DEFAULTS = {
  seatCapacity: null,
  availableSeats: null,
  verificationStatus: 'PENDING',
} as const;

export const saveVehicleInputSchema = z.object({
  type: z.enum(VEHICLE_TYPES),
  make: z.string().trim().min(1).max(50),
  model: z.string().trim().min(1).max(50),
  plateNumber: z.string().trim().min(1).max(20),
});

export function normalizePlate(value: string): { plateNumber: string; plateKey: string } {
  const plateNumber = value.trim().toUpperCase().replace(/\s+/g, ' ');
  return { plateNumber, plateKey: plateNumber.replace(/[\s-]/g, '') };
}

export function isValidPlate({
  plateNumber,
  plateKey,
}: {
  plateNumber: string;
  plateKey: string;
}): boolean {
  return (
    /^[A-Z0-9][A-Z0-9 -]*$/.test(plateNumber) &&
    plateNumber.length <= 20 &&
    /^[A-Z0-9]+$/.test(plateKey) &&
    plateKey.length >= 2 &&
    plateKey.length <= 12
  );
}

export interface VehicleCaller {
  uid: string;
  role: unknown;
  emailVerified: boolean;
}

export type SaveVehicleResult = { status: 'created' | 'updated' | 'unchanged' };

const IDENTITY_FIELDS = ['type', 'make', 'model', 'plateNumber', 'plateKey'] as const;

/**
 * Creates or updates the calling driver's vehicle. A driver has one vehicle and its document ID is
 * their uid. The plate number must be unique across all vehicles (compared without spaces and
 * hyphens, ignoring case); Firestore rules cannot check that, which is why this is a function.
 *
 * Changing any identifying detail sends a verified vehicle back to PENDING, because the
 * verification was for the earlier details. Saving identical details changes nothing.
 */
export async function saveVehicle(
  deps: { firestore: Firestore },
  caller: VehicleCaller,
  rawInput: unknown,
): Promise<SaveVehicleResult> {
  if (caller.role !== 'DRIVER' || !caller.emailVerified) {
    throw new HttpsError('permission-denied', 'Only verified drivers can save a vehicle.');
  }

  const parsed = saveVehicleInputSchema.safeParse(rawInput);
  const plate = parsed.success ? normalizePlate(parsed.data.plateNumber) : undefined;
  if (!parsed.success || !plate || !isValidPlate(plate)) {
    throw new HttpsError('invalid-argument', 'The vehicle details are not valid.');
  }
  const { type, make, model } = parsed.data;
  const details = { type, make, model, ...plate };

  const { firestore } = deps;
  const vehicleRef = firestore.collection('vehicles').doc(caller.uid);
  const userRef = firestore.collection('users').doc(caller.uid);
  const driverRef = firestore.collection('drivers').doc(caller.uid);
  const samePlate = firestore.collection('vehicles').where('plateKey', '==', plate.plateKey);

  return firestore.runTransaction(async (tx): Promise<SaveVehicleResult> => {
    const [user, driver, vehicle, plateOwners] = await Promise.all([
      tx.get(userRef),
      tx.get(driverRef),
      tx.get(vehicleRef),
      tx.get(samePlate),
    ]);

    if (!user.exists || user.get('status') !== 'ACTIVE' || !driver.exists) {
      throw new HttpsError('failed-precondition', 'This account cannot save a vehicle right now.');
    }
    if (plateOwners.docs.some((other) => other.id !== caller.uid)) {
      throw new HttpsError('already-exists', 'This plate number is already registered.');
    }

    if (!vehicle.exists) {
      tx.create(vehicleRef, {
        driverId: caller.uid,
        ...details,
        ...NEW_VEHICLE_DEFAULTS,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.create(firestore.collection('auditLogs').doc(), {
        timestamp: FieldValue.serverTimestamp(),
        actor: caller.uid,
        action: 'VEHICLE_CREATED',
        entity: `vehicles/${caller.uid}`,
        previousState: null,
        newState: { ...details, verificationStatus: NEW_VEHICLE_DEFAULTS.verificationStatus },
        reason: 'Driver added their vehicle',
      });
      return { status: 'created' };
    }

    const previous = Object.fromEntries(
      IDENTITY_FIELDS.map((field) => [field, vehicle.get(field)]),
    );
    if (IDENTITY_FIELDS.every((field) => previous[field] === details[field])) {
      return { status: 'unchanged' };
    }

    tx.update(vehicleRef, {
      ...details,
      verificationStatus: NEW_VEHICLE_DEFAULTS.verificationStatus,
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.create(firestore.collection('auditLogs').doc(), {
      timestamp: FieldValue.serverTimestamp(),
      actor: caller.uid,
      action: 'VEHICLE_UPDATED',
      entity: `vehicles/${caller.uid}`,
      previousState: { ...previous, verificationStatus: vehicle.get('verificationStatus') },
      newState: { ...details, verificationStatus: NEW_VEHICLE_DEFAULTS.verificationStatus },
      reason: 'Driver changed their vehicle details',
    });
    return { status: 'updated' };
  });
}
