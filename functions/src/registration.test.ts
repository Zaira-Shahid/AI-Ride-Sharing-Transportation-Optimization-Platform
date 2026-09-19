import { describe, expect, it } from 'vitest';
import { completeRegistrationInputSchema } from './registration.js';
import { isStaffRole } from './roles.js';

describe('completeRegistrationInputSchema', () => {
  it('accepts the two self-service roles', () => {
    for (const role of ['PASSENGER', 'DRIVER']) {
      expect(completeRegistrationInputSchema.safeParse({ role, name: 'Ada' }).success).toBe(true);
    }
  });

  it.each(['ADMIN', 'SUPER_ADMIN', 'OPERATIONS', 'SUPPORT', 'ROOT', '', undefined])(
    'rejects %s as a requested role',
    (role) => {
      expect(completeRegistrationInputSchema.safeParse({ role, name: 'Ada' }).success).toBe(false);
    },
  );

  it('trims the name and rejects an empty or oversized one', () => {
    const parsed = completeRegistrationInputSchema.parse({ role: 'DRIVER', name: '  Ada  ' });
    expect(parsed.name).toBe('Ada');
    expect(completeRegistrationInputSchema.safeParse({ role: 'DRIVER', name: '   ' }).success).toBe(
      false,
    );
    expect(
      completeRegistrationInputSchema.safeParse({ role: 'DRIVER', name: 'x'.repeat(101) }).success,
    ).toBe(false);
  });

  it('treats phone as optional', () => {
    expect(completeRegistrationInputSchema.parse({ role: 'DRIVER', name: 'Ada' }).phone).toBe(
      undefined,
    );
    expect(
      completeRegistrationInputSchema.safeParse({ role: 'DRIVER', name: 'Ada', phone: '' }).success,
    ).toBe(false);
  });

  it('ignores any extra role-like fields supplied by a client', () => {
    const parsed = completeRegistrationInputSchema.parse({
      role: 'PASSENGER',
      name: 'Ada',
      isAdmin: true,
    });
    expect(parsed).toEqual({ role: 'PASSENGER', name: 'Ada' });
  });
});

describe('isStaffRole', () => {
  it('only recognises staff roles', () => {
    expect(isStaffRole('ADMIN')).toBe(true);
    expect(isStaffRole('SUPPORT')).toBe(true);
    expect(isStaffRole('PASSENGER')).toBe(false);
    expect(isStaffRole(undefined)).toBe(false);
  });
});
