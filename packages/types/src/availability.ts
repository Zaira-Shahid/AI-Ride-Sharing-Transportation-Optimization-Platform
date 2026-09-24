import { z } from 'zod';
import type { DriverVerificationStatus } from './driver';
import { isValidDetourDistanceKm, isValidDetourMinutes } from './journey';
import { SEAT_CAPACITY_MIN, type VehicleVerificationStatus } from './vehicle';

export const AVAILABILITY_TARGETS = ['ONLINE', 'OFFLINE'] as const;

export const setAvailabilityInputSchema = z.object({ status: z.enum(AVAILABILITY_TARGETS) });
export type SetAvailabilityInput = z.infer<typeof setAvailabilityInputSchema>;

export interface SetAvailabilityResult {
  status: 'updated' | 'unchanged';
}

/** Why the server refused to go offline (Module 8.5), as details.reason. */
export const SET_AVAILABILITY_REFUSALS = ['PASSENGERS_ONBOARD'] as const;
export type SetAvailabilityRefusal = (typeof SET_AVAILABILITY_REFUSALS)[number];

/** What a driver needs before going online. Later Phase 2 modules add to this list. */
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
  /** users/{uid}.status is ACTIVE. */
  accountActive: boolean;
  driverStatus: DriverVerificationStatus | null;
  /** Null when the driver has not added a vehicle. */
  vehicleStatus: VehicleVerificationStatus | null;
  seatCapacity: number | null;
  /** The driver's open journey has a destination. */
  destinationDeclared: boolean;
  /** The driver has saved where the journey starts (Module 4.1). */
  originSet: boolean;
  /** Seats the driver offers on their open journey; null until they choose. */
  availableSeats: number | null;
  /** Extra minutes the driver accepts on their open journey; null until they choose. */
  maxDetourMinutes: number | null;
  /** Extra kilometres the driver accepts on their open journey; null until they choose. */
  maxDetourDistance: number | null;
}

export interface GoOnlineCheck {
  requirement: GoOnlineRequirement;
  met: boolean;
}

/**
 * Whether a driver may go online: an ACTIVE account, a VERIFIED driver, a VERIFIED vehicle, its
 * passenger seats set, a destination declared, the start of the journey saved (Module 4.1) and
 * seats on offer chosen (at least one, never more
 * than the vehicle has) and both detour limits chosen (whole minutes and kilometres within their
 * ranges). Mirrored in functions/src/availability.ts, which is what enforces it;
 * tests/roles-parity.test.ts fails if the two diverge. This copy drives the Home checklist.
 */
export function evaluateGoOnline(facts: GoOnlineFacts): {
  eligible: boolean;
  checks: GoOnlineCheck[];
} {
  const met: Record<GoOnlineRequirement, boolean> = {
    accountActive: facts.accountActive,
    driverVerified: facts.driverStatus === 'VERIFIED',
    vehicleAdded: facts.vehicleStatus !== null,
    vehicleVerified: facts.vehicleStatus === 'VERIFIED',
    seatsSet: facts.vehicleStatus !== null && typeof facts.seatCapacity === 'number',
    destinationDeclared: facts.destinationDeclared,
    originSet: facts.originSet,
    seatsOffered:
      facts.vehicleStatus !== null &&
      typeof facts.seatCapacity === 'number' &&
      typeof facts.availableSeats === 'number' &&
      Number.isInteger(facts.availableSeats) &&
      facts.availableSeats >= SEAT_CAPACITY_MIN &&
      facts.availableSeats <= facts.seatCapacity,
    detourSet:
      isValidDetourMinutes(facts.maxDetourMinutes) &&
      isValidDetourDistanceKm(facts.maxDetourDistance),
  };
  const checks = GO_ONLINE_REQUIREMENTS.map((requirement) => ({
    requirement,
    met: met[requirement],
  }));
  return { eligible: checks.every((check) => check.met), checks };
}
