import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { auditTakenOffline, offlineFields } from './availability.js';
import { requireVerifiedDriver, type DriverCaller } from './callers.js';

// Functions deploy from this directory alone, so these mirror @ridemesh/types.
// tests/roles-parity.test.ts fails if they diverge.
export const VEHICLE_TYPES = ['CAR', 'VAN', 'MINIBUS'] as const;
export const NEW_VEHICLE_DEFAULTS = {
  seatCapacity: null,
  availableSeats: null,
  verificationStatus: 'PENDING',
  verificationReason: null,
  verificationReviewedAt: null,
} as const;

// Seats for passengers, not counting the driver. Mirrors @ridemesh/types.
export const SEAT_CAPACITY_MIN = 1;
export const SEAT_CAPACITY_MAX = 6;

export const setVehicleCapacityInputSchema = z.object({
  seatCapacity: z.number().int().min(SEAT_CAPACITY_MIN).max(SEAT_CAPACITY_MAX),
});

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
  caller: DriverCaller,
  rawInput: unknown,
): Promise<SaveVehicleResult> {
  requireVerifiedDriver(caller);

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
      verificationReason: null,
      verificationReviewedAt: null,
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
    // The vehicle needs a new review, so the driver cannot stay online with it.
    const offline = offlineFields(driver);
    if (offline) {
      tx.update(driverRef, offline);
      auditTakenOffline(tx, firestore, caller.uid, caller.uid, 'Vehicle details changed');
    }
    return { status: 'updated' };
  });
}

export type SetVehicleCapacityResult = { status: 'updated' | 'unchanged' };

/**
 * Sets how many passenger seats the calling driver's vehicle has (1 to 6, the driver's seat not
 * counted). Raising the number, or setting it for the first time, sends the vehicle back to
 * PENDING, because the review did not cover those seats; lowering it never does. If the seats on
 * offer (availableSeats on the driver's journey, Module 2.7) would exceed the new capacity they are
 * lowered to match, so they can never be more than the vehicle holds.
 */
export async function setVehicleCapacity(
  deps: { firestore: Firestore },
  caller: DriverCaller,
  rawInput: unknown,
): Promise<SetVehicleCapacityResult> {
  requireVerifiedDriver(caller);

  const parsed = setVehicleCapacityInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'The number of seats is not valid.');
  }
  const { seatCapacity } = parsed.data;

  const { firestore } = deps;
  const vehicleRef = firestore.collection('vehicles').doc(caller.uid);
  const userRef = firestore.collection('users').doc(caller.uid);
  const driverRef = firestore.collection('drivers').doc(caller.uid);

  return firestore.runTransaction(async (tx): Promise<SetVehicleCapacityResult> => {
    const [user, vehicle, driver] = await Promise.all([
      tx.get(userRef),
      tx.get(vehicleRef),
      tx.get(driverRef),
    ]);
    if (!user.exists || user.get('status') !== 'ACTIVE' || !vehicle.exists) {
      throw new HttpsError('failed-precondition', 'This account cannot change seats right now.');
    }

    const previous: unknown = vehicle.get('seatCapacity');
    if (previous === seatCapacity) return { status: 'unchanged' };

    // Seats on offer live on the driver's own open journey; read it now, before any write.
    const journeyId: unknown = driver.get('currentJourneyId');
    const journeyRef =
      typeof journeyId === 'string' && journeyId
        ? firestore.collection('driverJourneys').doc(journeyId)
        : null;
    const journey = journeyRef ? await tx.get(journeyRef) : undefined;

    const raised = typeof previous !== 'number' || seatCapacity > previous;
    const previousAvailable: unknown = vehicle.get('availableSeats');
    const availableSeats =
      typeof previousAvailable === 'number' ? Math.min(previousAvailable, seatCapacity) : null;
    const verificationStatus = raised
      ? NEW_VEHICLE_DEFAULTS.verificationStatus
      : vehicle.get('verificationStatus');

    tx.update(vehicleRef, {
      seatCapacity,
      availableSeats,
      verificationStatus,
      // A new review starts from scratch, so the old decision no longer applies.
      ...(raised ? { verificationReason: null, verificationReviewedAt: null } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.create(firestore.collection('auditLogs').doc(), {
      timestamp: FieldValue.serverTimestamp(),
      actor: caller.uid,
      action: 'VEHICLE_CAPACITY_CHANGED',
      entity: `vehicles/${caller.uid}`,
      previousState: {
        seatCapacity: previous ?? null,
        availableSeats: previousAvailable ?? null,
        verificationStatus: vehicle.get('verificationStatus'),
      },
      newState: { seatCapacity, availableSeats, verificationStatus },
      reason: 'Driver changed the passenger seats of their vehicle',
    });
    // A journey can never offer more seats than the vehicle holds.
    const offered: unknown = journey?.get('availableSeats');
    if (
      journeyRef &&
      journey?.exists &&
      journey.get('driverId') === caller.uid &&
      typeof offered === 'number' &&
      offered > seatCapacity
    ) {
      tx.update(journeyRef, {
        availableSeats: seatCapacity,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    // More seats than were reviewed need a new review, so the driver cannot stay online.
    const offline = raised ? offlineFields(driver) : undefined;
    if (offline) {
      tx.update(driverRef, offline);
      auditTakenOffline(tx, firestore, caller.uid, caller.uid, 'Vehicle seats raised');
    }
    return { status: 'updated' };
  });
}
