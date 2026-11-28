import { COMPANY_NAME_MAX, PERSON_NAME_MAX, PHONE_MAX } from '@ridemesh/tenancy';

// Form checks for the company console (module A4a). They run before anything is sent, so a
// mistake is explained next to its field; the server checks again and has the final word.

export interface CreateCompanyValues {
  companyName: string;
  ownerName: string;
  phone: string;
}
export type CreateCompanyField = keyof CreateCompanyValues;

export type CreateCompanyValidation =
  | { ok: true; data: { name: string; ownerName: string; phone?: string } }
  | { ok: false; errors: Partial<Record<CreateCompanyField, string>> };

// The characters and length the other apps accept in a phone number (packages/types, auth.ts).
const PHONE_ALLOWED = /^[+\d ().-]+$/;

function plausiblePhone(value: string): boolean {
  const digits = value.replace(/\D/g, '').length;
  return PHONE_ALLOWED.test(value) && value.length <= PHONE_MAX && digits >= 7 && digits <= 15;
}

export function validateCreateCompany(values: CreateCompanyValues): CreateCompanyValidation {
  const errors: Partial<Record<CreateCompanyField, string>> = {};
  const name = values.companyName.trim();
  const owner = values.ownerName.trim();
  const phone = values.phone.trim();

  if (name.length < 2) errors.companyName = 'Enter your company name (at least 2 characters).';
  else if (name.length > COMPANY_NAME_MAX) {
    errors.companyName = `The company name must be ${COMPANY_NAME_MAX} characters or fewer.`;
  }
  if (owner.length === 0) errors.ownerName = 'Enter your full name.';
  else if (owner.length > PERSON_NAME_MAX) {
    errors.ownerName = `Your name must be ${PERSON_NAME_MAX} characters or fewer.`;
  }
  if (phone.length > 0 && !plausiblePhone(phone)) {
    errors.phone = 'Enter a valid phone number, or leave it empty.';
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, data: { name, ownerName: owner, ...(phone ? { phone } : {}) } };
}
