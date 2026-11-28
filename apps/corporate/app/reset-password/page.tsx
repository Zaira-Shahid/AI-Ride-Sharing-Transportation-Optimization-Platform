'use client';

import { describeAuthError, requestPasswordReset, type AuthFailure } from '@ridemesh/firebase';
import { useAuth } from '@ridemesh/firebase/react';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { AuthCard, ErrorNotice, InfoNotice } from '../../components/AuthCard';
import { TextField } from '../../components/TextField';
import { linkClass, primaryButtonClass } from '../../lib/ui';

export default function ResetPasswordPage() {
  const { client } = useAuth();
  const [email, setEmail] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFailure(null);
    setSent(false);
    setFieldError(undefined);
    setSubmitting(true);
    try {
      await requestPasswordReset(client, { email });
      setSent(true);
    } catch (error) {
      const failed = describeAuthError(error);
      if (failed.kind === 'invalid-email') setFieldError(failed.message);
      else setFailure(failed);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthCard
      title="Reset your password"
      subtitle="Enter your email and we will send you a link to choose a new password."
    >
      <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
        {failure ? <ErrorNotice message={failure.message} /> : null}
        {sent ? (
          <InfoNotice message="If that email belongs to an account, a reset link is on its way." />
        ) : null}
        <TextField
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={setEmail}
          error={fieldError}
          disabled={submitting}
        />
        <button type="submit" disabled={submitting} className={primaryButtonClass}>
          {submitting ? 'Sending…' : 'Send reset link'}
        </button>
      </form>
      <p className="text-sm text-clean-white/70">
        <Link href="/sign-in" className={linkClass}>
          Back to sign in
        </Link>
      </p>
    </AuthCard>
  );
}
