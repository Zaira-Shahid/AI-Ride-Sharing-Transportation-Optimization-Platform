'use client';

import { describeAuthError, signInStaff, type AuthFailure } from '@ridemesh/firebase';
import { useAuth } from '@ridemesh/firebase/react';
import { validateLogin, type LoginField, type LoginFormValues } from '@ridemesh/types';
import { useState, type FormEvent } from 'react';
import { APP_DISPLAY_NAMES } from '@ridemesh/config';

type FieldErrors = Partial<Record<LoginField, string>>;

/**
 * Module 11.1 (admin dashboard foundation): staff-only sign-in. Mirrors packages/mobile-auth's own
 * LoginScreen (same validateLogin/describeAuthError/runAuthFlow shape) but as plain web markup, and
 * calls signInStaff (accepts any of the 4 staff roles) rather than signIn (self-service roles only).
 */
export function LoginForm() {
  const { client, runAuthFlow } = useAuth();
  const [values, setValues] = useState<LoginFormValues>({ email: '', password: '' });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
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
      await runAuthFlow(() => signInStaff(client, values));
    } catch (error) {
      setFailure(describeAuthError(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex h-screen items-center justify-center px-4">
      <form
        onSubmit={(event) => void submit(event)}
        className="w-full max-w-sm space-y-4 rounded-xl border border-white/10 bg-deep-slate p-8"
      >
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-clean-white">
            {APP_DISPLAY_NAMES.admin}
          </h1>
          <p className="mt-1 text-sm text-clean-white/60">Sign in with your staff account.</p>
        </div>

        {failure ? (
          <p className="rounded-md bg-danger-red/10 px-3 py-2 text-sm text-danger-red">
            {failure.message}
          </p>
        ) : null}

        <label className="block text-sm text-clean-white/70">
          Email
          <input
            type="email"
            value={values.email}
            onChange={(event) => set('email')(event.target.value)}
            autoComplete="email"
            disabled={submitting}
            className="mt-1 w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-clean-white outline-none focus:border-electric-cyan"
          />
          {fieldErrors.email ? (
            <span className="mt-1 block text-xs text-danger-red">{fieldErrors.email}</span>
          ) : null}
        </label>

        <label className="block text-sm text-clean-white/70">
          Password
          <input
            type="password"
            value={values.password}
            onChange={(event) => set('password')(event.target.value)}
            autoComplete="current-password"
            disabled={submitting}
            className="mt-1 w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-clean-white outline-none focus:border-electric-cyan"
          />
          {fieldErrors.password ? (
            <span className="mt-1 block text-xs text-danger-red">{fieldErrors.password}</span>
          ) : null}
        </label>

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-md bg-electric-cyan px-3 py-2 text-sm font-medium text-midnight-navy transition-opacity disabled:opacity-60"
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
