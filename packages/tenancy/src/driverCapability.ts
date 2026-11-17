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

/**
 * Whether a member can actually drive right now (docs/a2b-driver-capability-design.md, section 2):
 * the company administrator's permission (canDrive) AND an active membership AND a driver profile
 * and a vehicle that are both VERIFIED at this moment. Every use of the capability goes through
 * this check, so a vehicle edited after approval, or a verification withdrawn by platform staff,
 * stops the person driving without any other code having to know about companies.
 */
export function hasEffectiveDriveCapability(facts: {
  canDrive: boolean;
  memberStatus: 'ACTIVE' | 'REMOVED';
  driverStatus: (typeof DRIVER_VERIFICATION_STATUSES)[number] | null;
  vehicleStatus: (typeof DRIVER_VERIFICATION_STATUSES)[number] | null;
}): boolean {
  return (
    facts.canDrive &&
    facts.memberStatus === 'ACTIVE' &&
    facts.driverStatus === 'VERIFIED' &&
    facts.vehicleStatus === 'VERIFIED'
  );
}
