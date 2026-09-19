import { z } from 'zod';

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export const REGISTRATION_FIELDS = [
  'name',
  'email',
  'phone',
  'password',
  'confirmPassword',
] as const;
export type RegistrationField = (typeof REGISTRATION_FIELDS)[number];

export interface RegistrationFormValues {
  name: string;
  email: string;
  phone: string;
  password: string;
  confirmPassword: string;
}

export interface ValidatedRegistration {
  name: string;
  email: string;
  phone?: string;
  password: string;
}

export type RegistrationValidation =
  | { ok: true; data: ValidatedRegistration }
  | { ok: false; errors: Partial<Record<RegistrationField, string>> };

export const LOGIN_FIELDS = ['email', 'password'] as const;
export type LoginField = (typeof LOGIN_FIELDS)[number];

export interface LoginFormValues {
  email: string;
  password: string;
}

export type LoginValidation =
  { ok: true; data: LoginFormValues } | { ok: false; errors: Partial<Record<LoginField, string>> };

const PHONE_ALLOWED = /^[+\d\s().-]+$/;

function isPlausiblePhone(value: string) {
  const digits = value.replace(/\D/g, '');
  return PHONE_ALLOWED.test(value) && digits.length >= 7 && digits.length <= 15;
}

const emailSchema = z.string().trim().toLowerCase().pipe(z.email());

/**
 * Validates the registration form and returns a message per invalid field. Phone is optional and
 * is dropped when left empty. Passwords are never trimmed.
 */
export function validateRegistration(values: RegistrationFormValues): RegistrationValidation {
  const errors: Partial<Record<RegistrationField, string>> = {};

  const name = values.name.trim();
  if (name.length === 0) errors.name = 'Enter your full name.';
  else if (name.length > 100) errors.name = 'Your name must be 100 characters or fewer.';

  const email = emailSchema.safeParse(values.email);
  if (!email.success) errors.email = 'Enter a valid email address.';

  const phone = values.phone.trim();
  if (phone.length > 0 && !isPlausiblePhone(phone)) {
    errors.phone = 'Enter a valid phone number, or leave it empty.';
  }

  if (values.password.length < PASSWORD_MIN_LENGTH) {
    errors.password = `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  } else if (values.password.length > PASSWORD_MAX_LENGTH) {
    errors.password = `Use no more than ${PASSWORD_MAX_LENGTH} characters.`;
  }

  if (values.confirmPassword !== values.password) {
    errors.confirmPassword = 'The passwords do not match.';
  }

  if (Object.keys(errors).length > 0 || !email.success) return { ok: false, errors };

  return {
    ok: true,
    data: {
      name,
      email: email.data,
      ...(phone.length > 0 ? { phone } : {}),
      password: values.password,
    },
  };
}

/**
 * Validates the sign-in form. The password is only checked for presence, not length, so accounts
 * created before a length rule existed can still sign in.
 */
export function validateLogin(values: LoginFormValues): LoginValidation {
  const errors: Partial<Record<LoginField, string>> = {};

  const email = emailSchema.safeParse(values.email);
  if (!email.success) errors.email = 'Enter a valid email address.';
  if (values.password.length === 0) errors.password = 'Enter your password.';

  if (Object.keys(errors).length > 0 || !email.success) return { ok: false, errors };
  return { ok: true, data: { email: email.data, password: values.password } };
}
