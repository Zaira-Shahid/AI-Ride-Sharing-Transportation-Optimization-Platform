'use client';

import { describeAuthError, type AuthFailure } from '@ridemesh/firebase';
import { createCompany } from '@ridemesh/firebase/company';
import { useAuth } from '@ridemesh/firebase/react';
import { useState, type FormEvent } from 'react';
import { AuthCard, ErrorNotice } from '../../components/AuthCard';
import { TextField } from '../../components/TextField';
import {
  validateCreateCompany,
  type CreateCompanyField,
  type CreateCompanyValues,
} from '../../lib/forms';
import { primaryButtonClass, secondaryButtonClass } from '../../lib/ui';

export default function CreateCompanyPage() {
  const { client, user, refresh, signOut } = useAuth();
  const [values, setValues] = useState<CreateCompanyValues>({
    companyName: '',
    ownerName: user?.displayName ?? '',
    phone: '',
  });
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<CreateCompanyField, string>>>({});
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const set = (field: CreateCompanyField) => (value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFailure(null);
    const validation = validateCreateCompany(values);
    if (!validation.ok) {
      setFieldErrors(validation.errors);
      return;
    }
    setFieldErrors({});
    setSubmitting(true);
    try {
      await createCompany(client, validation.data);
      // Reads the new claims; the gate then opens the dashboard.
      await refresh();
    } catch (error) {
      setFailure(describeAuthError(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthCard
      title="Create your company"
      subtitle="You will be its first administrator. You can invite colleagues next."
    >
      <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
        {failure ? <ErrorNotice message={failure.message} /> : null}
        <TextField
          label="Company name"
          autoComplete="organization"
          value={values.companyName}
          onChange={set('companyName')}
          error={fieldErrors.companyName}
          disabled={submitting}
        />
        <TextField
          label="Your full name"
          autoComplete="name"
          value={values.ownerName}
          onChange={set('ownerName')}
          error={fieldErrors.ownerName}
          disabled={submitting}
        />
        <TextField
          label="Phone (optional)"
          type="tel"
          autoComplete="tel"
          value={values.phone}
          onChange={set('phone')}
          error={fieldErrors.phone}
          disabled={submitting}
        />
        <button type="submit" disabled={submitting} className={primaryButtonClass}>
          {submitting ? 'Creating…' : 'Create company'}
        </button>
      </form>
      <button type="button" onClick={() => void signOut()} className={secondaryButtonClass}>
        Sign out
      </button>
    </AuthCard>
  );
}
