import { describe, expect, it } from 'vitest';
import {
  COMPANY_ROLES,
  INVITATION_TTL_DAYS,
  NEW_MEMBER_DEFAULTS,
  isCompanyAdmin,
  hasEffectiveDriveCapability,
  isDriveCapabilityConsistent,
  parseCompanyClaims,
} from './index';

describe('parseCompanyClaims', () => {
  const valid = { role: 'EMPLOYEE', companyId: 'c1', companyRole: 'EMPLOYEE' };

  it('accepts a complete company token, ignoring unrelated claims', () => {
    expect(parseCompanyClaims({ ...valid, email_verified: true, beta: 1 })).toEqual(valid);
  });

  it.each([
    ['a consumer', { role: 'PASSENGER' }],
    ['a driver', { role: 'DRIVER' }],
    ['staff', { role: 'ADMIN' }],
    ['no claims', {}],
    ['a missing company', { role: 'EMPLOYEE', companyRole: 'EMPLOYEE' }],
    ['a missing company role', { role: 'EMPLOYEE', companyId: 'c1' }],
    ['an unknown company role', { ...valid, companyRole: 'OWNER' }],
    ['an empty company', { ...valid, companyId: '' }],
    ['company claims on a non-employee role', { ...valid, role: 'PASSENGER' }],
    ['a company id that is not a string', { ...valid, companyId: 7 }],
    ['null', null],
    ['a string', 'EMPLOYEE'],
  ])('rejects %s', (_name, claims) => {
    expect(parseCompanyClaims(claims)).toBeNull();
  });
});

describe('isCompanyAdmin', () => {
  it('is true only for a COMPANY_ADMIN token', () => {
    expect(
      isCompanyAdmin(
        parseCompanyClaims({ role: 'EMPLOYEE', companyId: 'c1', companyRole: 'COMPANY_ADMIN' }),
      ),
    ).toBe(true);
    expect(
      isCompanyAdmin(
        parseCompanyClaims({ role: 'EMPLOYEE', companyId: 'c1', companyRole: 'EMPLOYEE' }),
      ),
    ).toBe(false);
    expect(isCompanyAdmin(null)).toBe(false);
  });
});

describe('isDriveCapabilityConsistent', () => {
  it('allows canDrive only when the driver and the vehicle are both VERIFIED', () => {
    expect(
      isDriveCapabilityConsistent({
        canDrive: true,
        driverStatus: 'VERIFIED',
        vehicleStatus: 'VERIFIED',
      }),
    ).toBe(true);
    for (const driverStatus of ['PENDING', 'REJECTED', null] as const) {
      expect(
        isDriveCapabilityConsistent({ canDrive: true, driverStatus, vehicleStatus: 'VERIFIED' }),
      ).toBe(false);
    }
    for (const vehicleStatus of ['PENDING', 'REJECTED', null] as const) {
      expect(
        isDriveCapabilityConsistent({ canDrive: true, driverStatus: 'VERIFIED', vehicleStatus }),
      ).toBe(false);
    }
  });

  it('never objects while canDrive is false, whatever the verification says', () => {
    expect(
      isDriveCapabilityConsistent({ canDrive: false, driverStatus: null, vehicleStatus: null }),
    ).toBe(true);
    expect(
      isDriveCapabilityConsistent({
        canDrive: false,
        driverStatus: 'VERIFIED',
        vehicleStatus: 'VERIFIED',
      }),
    ).toBe(true);
  });
});

describe('constants', () => {
  it('starts a new member as an active, non-driving member with no reviewer', () => {
    expect(NEW_MEMBER_DEFAULTS).toEqual({
      status: 'ACTIVE',
      canDrive: false,
      driverReviewedBy: null,
      driverReviewedAt: null,
      driverRequestedAt: null,
    });
  });

  it('lists the two company roles and a seven-day invitation', () => {
    expect([...COMPANY_ROLES]).toEqual(['COMPANY_ADMIN', 'EMPLOYEE']);
    expect(INVITATION_TTL_DAYS).toBe(7);
  });
});

describe('hasEffectiveDriveCapability', () => {
  const ok = {
    canDrive: true,
    memberStatus: 'ACTIVE',
    driverStatus: 'VERIFIED',
    vehicleStatus: 'VERIFIED',
  } as const;

  it('is true only with the permission, an active membership and both verifications', () => {
    expect(hasEffectiveDriveCapability(ok)).toBe(true);
  });

  it.each([
    ['no permission', { ...ok, canDrive: false }],
    ['a removed member', { ...ok, memberStatus: 'REMOVED' }],
    ['a pending driver profile', { ...ok, driverStatus: 'PENDING' }],
    ['a rejected driver profile', { ...ok, driverStatus: 'REJECTED' }],
    ['no driver profile', { ...ok, driverStatus: null }],
    ['a vehicle edited after approval (pending)', { ...ok, vehicleStatus: 'PENDING' }],
    ['a vehicle rejected by platform staff', { ...ok, vehicleStatus: 'REJECTED' }],
    ['no vehicle', { ...ok, vehicleStatus: null }],
  ] as const)('is false with %s', (_name, facts) => {
    expect(hasEffectiveDriveCapability(facts)).toBe(false);
  });
});
