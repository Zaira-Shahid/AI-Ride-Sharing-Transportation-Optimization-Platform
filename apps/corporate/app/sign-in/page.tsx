'use client';

import { APP_DISPLAY_NAMES } from '@ridemesh/config';
import { describeAuthError, type AuthFailure } from '@ridemesh/firebase';
import { signInCompanyAdmin } from '@ridemesh/firebase/company';
import { useAuth } from '@ridemesh/firebase/react';
import { validateLogin, type LoginField } from '@ridemesh/types';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { AuthCard, ErrorNotice } from '../../components/AuthCard';
import { TextField } from '../../components/TextField';
import { linkClass, primaryButtonClass } from '../../lib/ui';

export default function SignInPage() {
  const { client, runAuthFlow } = useAuth();
  const [values, setValues] = useState({ email: '', password: '' });
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<LoginField, string>>>({});
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const set = (field: LoginField) => (value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFailure(null);
    const validation = validateLogin(values);
    if (!validation.ok) {
      setFieldErrors(validation.errors);
      return;
    }
    setFieldErrors({});
    setSubmitting(true);
    try {
      await runAuthFlow(() => signInCompanyAdmin(client, values));
    } catch (error) {
      setFailure(describeAuthError(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthCard title={APP_DISPLAY_NAMES.company} subtitle="Sign in to manage your company.">
      <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
        {failure ? <ErrorNotice message={failure.message} /> : null}
        <TextField
          label="Email"
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
          autoComplete="current-password"
          value={values.password}
          onChange={set('password')}
          error={fieldErrors.password}
          disabled={submitting}
        />
        <button type="submit" disabled={submitting} className={primaryButtonClass}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p className="text-sm text-clean-white/70">
        <Link href="/reset-password" className={linkClass}>
          Forgot your password?
        </Link>
      </p>
      <p className="text-sm text-clean-white/70">
        New here?{' '}
        <Link href="/sign-up" className={linkClass}>
          Create a company account
        </Link>
      </p>
    </AuthCard>
  );
}
