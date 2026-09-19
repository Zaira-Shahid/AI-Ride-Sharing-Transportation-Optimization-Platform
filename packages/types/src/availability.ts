import { z } from 'zod';
import type { DriverVerificationStatus } from './driver';
import type { VehicleVerificationStatus } from './vehicle';

export const AVAILABILITY_TARGETS = ['ONLINE', 'OFFLINE'] as const;

export const setAvailabilityInputSchema = z.object({ status: z.enum(AVAILABILITY_TARGETS) });
export type SetAvailabilityInput = z.infer<typeof setAvailabilityInputSchema>;

export interface SetAvailabilityResult {
  status: 'updated' | 'unchanged';
}

/** What a driver needs before going online. Later Phase 2 modules add to this list. */
export const GO_ONLINE_REQUIREMENTS = [
  'accountActive',
  'driverVerified',
  'vehicleAdded',
  'vehicleVerified',
  'seatsSet',
  'destinationDeclared',
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
}

export interface GoOnlineCheck {
  requirement: GoOnlineRequirement;
  met: boolean;
}

/**
 * Whether a driver may go online: an ACTIVE account, a VERIFIED driver, a VERIFIED vehicle, its
 * passenger seats set and a destination declared. Mirrored in functions/src/availability.ts, which is what enforces it;
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
  };
  const checks = GO_ONLINE_REQUIREMENTS.map((requirement) => ({
    requirement,
    met: met[requirement],
  }));
  return { eligible: checks.every((check) => check.met), checks };
}
