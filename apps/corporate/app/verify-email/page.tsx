'use client';

import { describeAuthError, type AuthFailure } from '@ridemesh/firebase';
import { resendVerificationEmail } from '@ridemesh/firebase/company';
import { useAuth } from '@ridemesh/firebase/react';
import { useCallback, useEffect, useState } from 'react';
import { AuthCard, ErrorNotice, InfoNotice } from '../../components/AuthCard';
import { primaryButtonClass, secondaryButtonClass } from '../../lib/ui';

export default function VerifyEmailPage() {
  const { client, user, refresh, signOut } = useAuth();
  const [busy, setBusy] = useState<'resend' | 'check' | null>(null);
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const check = useCallback(
    async (quiet: boolean) => {
      setBusy('check');
      setFailure(null);
      try {
        await refresh();
        if (!quiet) setNotice('Your email is not verified yet. Open the link in the email first.');
      } catch (error) {
        if (!quiet) setFailure(describeAuthError(error));
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  // Coming back to this tab after opening the link in the email checks again by itself. Once the
  // email is verified the session changes and the gate moves on to creating the company.
  useEffect(() => {
    const onFocus = () => void check(true);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [check]);

  const resend = async () => {
    setBusy('resend');
    setFailure(null);
    setNotice(null);
    try {
      await resendVerificationEmail(client);
      setNotice('We sent the email again. It can take a minute to arrive.');
    } catch (error) {
      setFailure(describeAuthError(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <AuthCard
      title="Verify your email"
      subtitle={
        user?.email
          ? `We sent a link to ${user.email}. Open it, then come back here.`
          : 'We sent you a link. Open it, then come back here.'
      }
    >
      {failure ? <ErrorNotice message={failure.message} /> : null}
      {notice ? <InfoNotice message={notice} /> : null}
      <button
        type="button"
        onClick={() => void check(false)}
        disabled={busy !== null}
        className={primaryButtonClass}
      >
        {busy === 'check' ? 'Checking…' : 'I have verified my email'}
      </button>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void resend()}
          disabled={busy !== null}
          className={secondaryButtonClass}
        >
          {busy === 'resend' ? 'Sending…' : 'Send the email again'}
        </button>
        <button type="button" onClick={() => void signOut()} className={secondaryButtonClass}>
          Use a different account
        </button>
      </div>
    </AuthCard>
  );
}
