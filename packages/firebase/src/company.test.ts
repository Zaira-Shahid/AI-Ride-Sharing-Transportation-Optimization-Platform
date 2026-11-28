import { describe, expect, it } from 'vitest';
import { companyConsoleAccess } from './company';

const admin = { role: 'EMPLOYEE', companyId: 'c1', companyRole: 'COMPANY_ADMIN' };

describe('companyConsoleAccess', () => {
  it('lets a company administrator in', () => {
    expect(companyConsoleAccess(admin)).toBe('admin');
    expect(companyConsoleAccess({ ...admin, email_verified: true, iat: 1 })).toBe('admin');
  });

  it('sends an account with no role yet to create its company', () => {
    expect(companyConsoleAccess({})).toBe('needs-company');
    expect(companyConsoleAccess({ email_verified: true })).toBe('needs-company');
    expect(companyConsoleAccess({ role: null })).toBe('needs-company');
    expect(companyConsoleAccess(null)).toBe('needs-company');
    expect(companyConsoleAccess(undefined)).toBe('needs-company');
  });

  it.each([
    ['an ordinary employee', { ...admin, companyRole: 'EMPLOYEE' }],
    ['a passenger', { role: 'PASSENGER' }],
    ['a driver', { role: 'DRIVER' }],
    ['platform staff', { role: 'ADMIN' }],
    ['a super administrator', { role: 'SUPER_ADMIN' }],
    ['an employee token with no company', { role: 'EMPLOYEE' }],
    ['an employee token with no company role', { role: 'EMPLOYEE', companyId: 'c1' }],
    ['an administrator role on a non-employee platform role', { ...admin, role: 'ADMIN' }],
    ['a company role with a passenger role', { ...admin, role: 'PASSENGER' }],
    ['an unknown company role', { ...admin, companyRole: 'OWNER' }],
    ['an empty company id', { ...admin, companyId: '' }],
    ['a company id that is not text', { ...admin, companyId: 7 }],
    ['a role that is not text', { role: 7 }],
  ])('refuses %s', (_label, claims) => {
    expect(companyConsoleAccess(claims)).toBe('refused');
  });
});
