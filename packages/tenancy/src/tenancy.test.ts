import { describe, expect, it } from 'vitest';
import {
  COMPANY_ROLES,
  INVITATION_TTL_DAYS,
  NEW_MEMBER_DEFAULTS,
  isCompanyAdmin,
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
    });
  });

  it('lists the two company roles and a seven-day invitation', () => {
    expect([...COMPANY_ROLES]).toEqual(['COMPANY_ADMIN', 'EMPLOYEE']);
    expect(INVITATION_TTL_DAYS).toBe(7);
  });
});
