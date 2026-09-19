import { z } from 'zod';
import type { FirestoreTimestamp } from './user';

// The values below are the starting set for Module 2.1. Module 2.4 (verification) and Module 2.5
// (availability) own their lifecycles and may extend them.
export const DRIVER_VERIFICATION_STATUSES = ['PENDING', 'VERIFIED', 'REJECTED'] as const;
export const driverVerificationStatusSchema = z.enum(DRIVER_VERIFICATION_STATUSES);
export type DriverVerificationStatus = z.infer<typeof driverVerificationStatusSchema>;

export const DRIVER_AVAILABILITY_STATUSES = ['OFFLINE', 'ONLINE'] as const;
export const driverAvailabilityStatusSchema = z.enum(DRIVER_AVAILABILITY_STATUSES);
export type DriverAvailabilityStatus = z.infer<typeof driverAvailabilityStatusSchema>;

// drivers/{userId}. The document ID is the driver's uid. Created by server-side code when a driver
// registers; clients can read their own document but never write it. Detour settings stay null
// until the driver sets them (Module 2.8, which also fixes the unit of maxDetourDistance).
export interface DriverProfile {
  userId: string;
  verificationStatus: DriverVerificationStatus;
  /** Why staff rejected the driver. Null unless the status is REJECTED. */
  verificationReason: string | null;
  /** When staff last decided. Null until then, and again after a new review is requested. */
  verificationReviewedAt: FirestoreTimestamp | null;
  availabilityStatus: DriverAvailabilityStatus;
  /** When availabilityStatus last changed. Null until the driver first goes online. */
  availabilityChangedAt: FirestoreTimestamp | null;
  rating: number | null;
  totalTrips: number;
  maxDetourMinutes: number | null;
  maxDetourDistance: number | null;
  automaticMatchingEnabled: boolean | null;
  createdAt: FirestoreTimestamp;
  updatedAt: FirestoreTimestamp;
}

// What a new driver profile starts with (everything except userId and the timestamps). Mirrored
// in functions/src/drivers.ts; tests/roles-parity.test.ts fails if the two diverge.
export const NEW_DRIVER_PROFILE_DEFAULTS = {
  verificationStatus: 'PENDING',
  verificationReason: null,
  verificationReviewedAt: null,
  availabilityStatus: 'OFFLINE',
  availabilityChangedAt: null,
  rating: null,
  totalTrips: 0,
  maxDetourMinutes: null,
  maxDetourDistance: null,
  automaticMatchingEnabled: null,
} as const satisfies Omit<DriverProfile, 'userId' | 'createdAt' | 'updatedAt'>;
