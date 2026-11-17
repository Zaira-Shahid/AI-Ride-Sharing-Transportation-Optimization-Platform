import type { DRIVER_VERIFICATION_STATUSES } from '@ridemesh/types';

/**
 * The invariant between a member's `canDrive` and the existing driver and vehicle verification
 * fields (docs/a1-tenancy-design.md, section 3): a member can drive only if both their driver
 * profile and their vehicle are VERIFIED. The company-scoped review function (module A2) is the
 * only writer of all three, and its tests assert this holds after every call.
 *
 * It is one-directional on purpose: a verified driver with canDrive false is allowed (the
 * capability was revoked, or has not been granted yet), but canDrive true without both
 * verifications never is.
 */
export function isDriveCapabilityConsistent(facts: {
  canDrive: boolean;
  driverStatus: (typeof DRIVER_VERIFICATION_STATUSES)[number] | null;
  vehicleStatus: (typeof DRIVER_VERIFICATION_STATUSES)[number] | null;
}): boolean {
  if (!facts.canDrive) return true;
  return facts.driverStatus === 'VERIFIED' && facts.vehicleStatus === 'VERIFIED';
}
