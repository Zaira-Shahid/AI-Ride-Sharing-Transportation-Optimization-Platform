'use client';

import { APP_DISPLAY_NAMES } from '@ridemesh/config';
import { describeAuthError, type AuthFailure } from '@ridemesh/firebase';
import { registerCompanyAccount } from '@ridemesh/firebase/company';
import { useAuth } from '@ridemesh/firebase/react';
import { validateRegistration, type RegistrationField } from '@ridemesh/types';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { AuthCard, ErrorNotice } from '../../components/AuthCard';
import { TextField } from '../../components/TextField';
import { linkClass, primaryButtonClass } from '../../lib/ui';

type Field = 'name' | 'email' | 'password' | 'confirmPassword';

export default function SignUpPage() {
  const { client, runAuthFlow } = useAuth();
  const [values, setValues] = useState({ name: '', email: '', password: '', confirmPassword: '' });
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<RegistrationField, string>>>({});
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const set = (field: Field) => (value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFailure(null);
    const validation = validateRegistration({ ...values, phone: '' });
    if (!validation.ok) {
      setFieldErrors(validation.errors);
      return;
    }
    setFieldErrors({});
    setSubmitting(true);
    try {
      // The session only changes once the whole flow has finished, so the page does not jump to the
      // verification screen half-way through.
      await runAuthFlow(() => registerCompanyAccount(client, values));
    } catch (error) {
      setFailure(describeAuthError(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthCard
      title={APP_DISPLAY_NAMES.company}
      subtitle="Create the account you will use to manage your company."
    >
      <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
        {failure ? <ErrorNotice message={failure.message} /> : null}
        <TextField
          label="Your full name"
          autoComplete="name"
          value={values.name}
          onChange={set('name')}
          error={fieldErrors.name}
          disabled={submitting}
        />
        <TextField
          label="Work email"
          type="email"
          autoComplete="email"
          value={values.email}
          onChange={set('email')}
          error={fieldErrors.email}
          disabled={submitting}
        />
        <TextField
          label="Password"
          type="password"
          autoComplete="new-password"
          value={values.password}
          onChange={set('password')}
          error={fieldErrors.password}
          hint="At least 8 characters."
          disabled={submitting}
        />
        <TextField
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          value={values.confirmPassword}
          onChange={set('confirmPassword')}
          error={fieldErrors.confirmPassword}
          disabled={submitting}
        />
        <button type="submit" disabled={submitting} className={primaryButtonClass}>
          {submitting ? 'Creating account…' : 'Create account'}
        </button>
      </form>
      <p className="text-sm text-clean-white/70">
        Already have an account?{' '}
        <Link href="/sign-in" className={linkClass}>
          Sign in
        </Link>
      </p>
    </AuthCard>
  );
}
