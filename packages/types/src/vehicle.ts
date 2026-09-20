import { z } from 'zod';
import type { FirestoreTimestamp } from './user';

export const VEHICLE_TYPES = ['CAR', 'VAN', 'MINIBUS'] as const;
export const vehicleTypeSchema = z.enum(VEHICLE_TYPES);
export type VehicleType = z.infer<typeof vehicleTypeSchema>;

// Same starting set as the driver's verification status; Module 2.4 owns how it changes.
export const VEHICLE_VERIFICATION_STATUSES = ['PENDING', 'VERIFIED', 'REJECTED'] as const;
export const vehicleVerificationStatusSchema = z.enum(VEHICLE_VERIFICATION_STATUSES);
export type VehicleVerificationStatus = z.infer<typeof vehicleVerificationStatusSchema>;

export const VEHICLE_MAKE_MODEL_MAX_LENGTH = 50;
export const PLATE_DISPLAY_MAX_LENGTH = 20;
export const PLATE_KEY_MIN_LENGTH = 2;
export const PLATE_KEY_MAX_LENGTH = 12;

// vehicles/{userId}. A driver has one vehicle and its document ID is the driver's uid. Created and
// changed only by the saveVehicle function; clients can read their own but never write it.
// seatCapacity is set in Module 2.3. Seats on offer live on the driver's journey (Module 2.7), so
// availableSeats is kept as in the spec but stays null.
export interface VehicleProfile {
  driverId: string;
  type: VehicleType;
  make: string;
  model: string;
  /** As the driver typed it, tidied: upper case, single spaces. */
  plateNumber: string;
  /** plateNumber without spaces and hyphens. Two vehicles can never share one. */
  plateKey: string;
  seatCapacity: number | null;
  availableSeats: number | null;
  verificationStatus: VehicleVerificationStatus;
  /** Why staff rejected the vehicle. Null unless the status is REJECTED. */
  verificationReason: string | null;
  /** When staff last decided. Null until then, and again once the vehicle goes back to PENDING. */
  verificationReviewedAt: FirestoreTimestamp | null;
  createdAt: FirestoreTimestamp;
  updatedAt: FirestoreTimestamp;
}

// What a new vehicle starts with besides its details. Mirrored in functions/src/vehicles.ts;
// tests/roles-parity.test.ts fails if the two diverge.
export const NEW_VEHICLE_DEFAULTS = {
  seatCapacity: null,
  availableSeats: null,
  verificationStatus: 'PENDING',
  verificationReason: null,
  verificationReviewedAt: null,
} as const;

export interface NormalizedPlate {
  plateNumber: string;
  plateKey: string;
}

/** Upper-cases a plate and tidies its spacing; the key also drops spaces and hyphens. */
export function normalizePlate(value: string): NormalizedPlate {
  const plateNumber = value.trim().toUpperCase().replace(/\s+/g, ' ');
  return { plateNumber, plateKey: plateNumber.replace(/[\s-]/g, '') };
}

/** Letters, digits, spaces and hyphens only, with a plausible length. No country format is assumed. */
export function isValidPlate({ plateNumber, plateKey }: NormalizedPlate): boolean {
  return (
    /^[A-Z0-9][A-Z0-9 -]*$/.test(plateNumber) &&
    plateNumber.length <= PLATE_DISPLAY_MAX_LENGTH &&
    /^[A-Z0-9]+$/.test(plateKey) &&
    plateKey.length >= PLATE_KEY_MIN_LENGTH &&
    plateKey.length <= PLATE_KEY_MAX_LENGTH
  );
}

export const saveVehicleInputSchema = z.object({
  type: vehicleTypeSchema,
  make: z.string().trim().min(1).max(VEHICLE_MAKE_MODEL_MAX_LENGTH),
  model: z.string().trim().min(1).max(VEHICLE_MAKE_MODEL_MAX_LENGTH),
  plateNumber: z.string().trim().min(1).max(PLATE_DISPLAY_MAX_LENGTH),
});
export type SaveVehicleInput = z.infer<typeof saveVehicleInputSchema>;

export interface SaveVehicleResult {
  status: 'created' | 'updated' | 'unchanged';
}

export interface VehicleFormValues {
  type: VehicleType | '';
  make: string;
  model: string;
  plateNumber: string;
}

export type VehicleField = keyof VehicleFormValues;

export type VehicleValidation =
  | { ok: true; data: SaveVehicleInput }
  | { ok: false; errors: Partial<Record<VehicleField, string>> };

/** Validates the vehicle form the same way the server does, so the person sees problems early. */
export function validateVehicle(values: VehicleFormValues): VehicleValidation {
  const errors: Partial<Record<VehicleField, string>> = {};

  const type = vehicleTypeSchema.safeParse(values.type);
  if (!type.success) errors.type = 'Choose your vehicle type.';

  const make = values.make.trim();
  if (make.length === 0) errors.make = 'Enter the make, for example Toyota.';
  else if (make.length > VEHICLE_MAKE_MODEL_MAX_LENGTH) {
    errors.make = `Use ${VEHICLE_MAKE_MODEL_MAX_LENGTH} characters or fewer.`;
  }

  const model = values.model.trim();
  if (model.length === 0) errors.model = 'Enter the model, for example Corolla.';
  else if (model.length > VEHICLE_MAKE_MODEL_MAX_LENGTH) {
    errors.model = `Use ${VEHICLE_MAKE_MODEL_MAX_LENGTH} characters or fewer.`;
  }

  const plate = normalizePlate(values.plateNumber);
  if (plate.plateNumber.length === 0) errors.plateNumber = 'Enter your plate number.';
  else if (!isValidPlate(plate)) {
    errors.plateNumber = 'Use 2 to 12 letters or numbers. Spaces and hyphens are fine.';
  }

  if (Object.keys(errors).length > 0 || !type.success) return { ok: false, errors };
  return { ok: true, data: { type: type.data, make, model, plateNumber: plate.plateNumber } };
}

// seatCapacity is the number of seats for passengers; the driver's own seat is not counted.
export const SEAT_CAPACITY_MIN = 1;
export const SEAT_CAPACITY_MAX = 6;

export const setVehicleCapacityInputSchema = z.object({
  seatCapacity: z.number().int().min(SEAT_CAPACITY_MIN).max(SEAT_CAPACITY_MAX),
});
export type SetVehicleCapacityInput = z.infer<typeof setVehicleCapacityInputSchema>;

export interface SetVehicleCapacityResult {
  status: 'updated' | 'unchanged';
}

export type SeatCapacityValidation =
  { ok: true; data: SetVehicleCapacityInput } | { ok: false; error: string };

/** Validates a chosen seat count the same way the server does. */
export function validateSeatCapacity(value: number | null): SeatCapacityValidation {
  const parsed = setVehicleCapacityInputSchema.safeParse({ seatCapacity: value });
  if (parsed.success) return { ok: true, data: parsed.data };
  return {
    ok: false,
    error: `Choose between ${SEAT_CAPACITY_MIN} and ${SEAT_CAPACITY_MAX} passenger seats.`,
  };
}
