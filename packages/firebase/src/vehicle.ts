import {
  VEHICLE_VERIFICATION_STATUSES,
  VEHICLE_TYPES,
  validateSeatCapacity,
  validateVehicle,
  type SaveVehicleInput,
  type SaveVehicleResult,
  type SetVehicleCapacityInput,
  type SetVehicleCapacityResult,
  type VehicleFormValues,
  type VehicleType,
  type VehicleVerificationStatus,
} from '@ridemesh/types';
import { doc, onSnapshot } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { AuthFlowError, getErrorCode } from './auth-errors';
import type { FirebaseClient } from './client';

export interface VehicleData {
  type: VehicleType;
  make: string;
  model: string;
  plateNumber: string;
  /** Seats for passengers, not counting the driver. Null until the driver sets it. */
  seatCapacity: number | null;
  verificationStatus: VehicleVerificationStatus;
  /** Why staff rejected the vehicle, when they did. */
  verificationReason: string | null;
}

export type VehicleSnapshot = { status: 'ready'; vehicle: VehicleData } | { status: 'missing' };

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return (values as readonly unknown[]).includes(value);
}

/** Follows vehicles/{uid} live. A driver can read but never write this document directly. */
export function subscribeToVehicle(
  client: Pick<FirebaseClient, 'firestore'>,
  uid: string,
  onChange: (snapshot: VehicleSnapshot) => void,
  onError: (error: unknown) => void,
): () => void {
  return onSnapshot(
    doc(client.firestore, 'vehicles', uid),
    (snapshot) => {
      const data = snapshot.data();
      if (!snapshot.exists() || !data || !isOneOf(VEHICLE_TYPES, data.type)) {
        onChange({ status: 'missing' });
        return;
      }
      onChange({
        status: 'ready',
        vehicle: {
          type: data.type,
          make: String(data.make ?? ''),
          model: String(data.model ?? ''),
          plateNumber: String(data.plateNumber ?? ''),
          seatCapacity: typeof data.seatCapacity === 'number' ? data.seatCapacity : null,
          // An unrecognised value is treated as the safest state rather than shown as verified.
          verificationStatus: isOneOf(VEHICLE_VERIFICATION_STATUSES, data.verificationStatus)
            ? data.verificationStatus
            : 'PENDING',
          verificationReason:
            typeof data.verificationReason === 'string' ? data.verificationReason : null,
        },
      });
    },
    onError,
  );
}

/**
 * Saves the signed-in driver's vehicle through the saveVehicle function, which also makes sure the
 * plate number is not already registered to another vehicle.
 */
export async function saveVehicle(
  client: Pick<FirebaseClient, 'functions'>,
  values: VehicleFormValues,
): Promise<SaveVehicleResult['status']> {
  const validation = validateVehicle(values);
  if (!validation.ok) {
    throw new AuthFlowError('validation', 'Please check the highlighted fields.');
  }

  try {
    const result = await httpsCallable<SaveVehicleInput, SaveVehicleResult>(
      client.functions,
      'saveVehicle',
    )(validation.data);
    return result.data.status;
  } catch (error) {
    if (getErrorCode(error) === 'functions/failed-precondition') {
      throw new AuthFlowError(
        'permission',
        'Your account cannot save a vehicle right now. Please contact support.',
      );
    }
    throw error;
  }
}

/** Sets how many passenger seats the signed-in driver's vehicle has (the driver's seat not counted). */
export async function setVehicleCapacity(
  client: Pick<FirebaseClient, 'functions'>,
  seatCapacity: number | null,
): Promise<SetVehicleCapacityResult['status']> {
  const validation = validateSeatCapacity(seatCapacity);
  if (!validation.ok) throw new AuthFlowError('validation', validation.error);

  try {
    const result = await httpsCallable<SetVehicleCapacityInput, SetVehicleCapacityResult>(
      client.functions,
      'setVehicleCapacity',
    )(validation.data);
    return result.data.status;
  } catch (error) {
    if (getErrorCode(error) === 'functions/failed-precondition') {
      throw new AuthFlowError(
        'permission',
        'Your account cannot change seats right now. Please contact support.',
      );
    }
    throw error;
  }
}
