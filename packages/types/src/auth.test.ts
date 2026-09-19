import { describe, expect, it } from 'vitest';
import { PASSWORD_MIN_LENGTH, validateRegistration, type RegistrationFormValues } from './auth';

const valid: RegistrationFormValues = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  phone: '',
  password: 'correct-horse',
  confirmPassword: 'correct-horse',
};

describe('validateRegistration', () => {
  it('accepts a complete form and drops an empty phone', () => {
    const result = validateRegistration(valid);
    expect(result).toEqual({
      ok: true,
      data: { name: 'Ada Lovelace', email: 'ada@example.com', password: 'correct-horse' },
    });
  });

  it('normalises the email and trims the name', () => {
    const result = validateRegistration({ ...valid, name: '  Ada  ', email: '  ADA@Example.COM ' });
    expect(result.ok && result.data).toMatchObject({ name: 'Ada', email: 'ada@example.com' });
  });

  it('keeps a plausible phone number', () => {
    const result = validateRegistration({ ...valid, phone: ' +44 (0) 7700-900123 ' });
    expect(result.ok && result.data.phone).toBe('+44 (0) 7700-900123');
  });

  it.each(['abc', '123', '+44 77 00 900 123 456 789', '077-abc-9001'])(
    'rejects the implausible phone %s',
    (phone) => {
      const result = validateRegistration({ ...valid, phone });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.errors.phone).toBeDefined();
    },
  );

  it('requires a password of at least 8 characters', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(8);
    const short = 'x'.repeat(7);
    const rejected = validateRegistration({ ...valid, password: short, confirmPassword: short });
    expect(!rejected.ok && rejected.errors.password).toContain('8');

    const exact = 'x'.repeat(8);
    expect(validateRegistration({ ...valid, password: exact, confirmPassword: exact }).ok).toBe(
      true,
    );
  });

  it('does not trim the password', () => {
    const result = validateRegistration({
      ...valid,
      password: '  spaced out  ',
      confirmPassword: '  spaced out  ',
    });
    expect(result.ok && result.data.password).toBe('  spaced out  ');
  });

  it('rejects a mismatched confirmation', () => {
    const result = validateRegistration({ ...valid, confirmPassword: 'different-one' });
    expect(!result.ok && result.errors.confirmPassword).toBeDefined();
  });

  it('rejects a missing name and an invalid email together', () => {
    const result = validateRegistration({ ...valid, name: '  ', email: 'not-an-email' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.errors).sort()).toEqual(['email', 'name']);
  });

  it('rejects an oversized name', () => {
    const result = validateRegistration({ ...valid, name: 'x'.repeat(101) });
    expect(!result.ok && result.errors.name).toBeDefined();
  });
});
