import { describeAuthError } from '@ridemesh/firebase';
import { useAuth } from '@ridemesh/firebase/react';
import { sendEmailVerification } from 'firebase/auth';
import { useEffect, useState } from 'react';
import type { AuthScreenProps } from '../app-info';
import { AuthFrame, Heading, Notice, PrimaryButton, TextButton } from '../components';

const RESEND_COOLDOWN_SECONDS = 60;

export function VerifyEmailScreen({ theme }: AuthScreenProps) {
  const { client, user, refresh, signOut } = useAuth();
  const [checking, setChecking] = useState(false);
  const [resending, setResending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [notice, setNotice] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((seconds) => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const checkVerified = async () => {
    setNotice(null);
    setChecking(true);
    try {
      await refresh();
      // When verification succeeded the session changes and this screen is replaced.
      if (!client.auth.currentUser?.emailVerified) {
        setNotice({
          tone: 'info',
          text: 'We have not seen your verification yet. Open the link in the email, then try again.',
        });
      }
    } catch (error) {
      setNotice({ tone: 'error', text: describeAuthError(error).message });
    } finally {
      setChecking(false);
    }
  };

  const resend = async () => {
    if (!user) return;
    setNotice(null);
    setResending(true);
    try {
      await sendEmailVerification(user);
      setCooldown(RESEND_COOLDOWN_SECONDS);
      setNotice({ tone: 'info', text: 'We sent you a new verification email.' });
    } catch (error) {
      setNotice({ tone: 'error', text: describeAuthError(error).message });
    } finally {
      setResending(false);
    }
  };

  return (
    <AuthFrame theme={theme}>
      <Heading
        title="Verify your email"
        subtitle={
          user?.email
            ? `We sent a link to ${user.email}. Open it to verify your account, then come back here.`
            : 'Open the link we emailed you to verify your account, then come back here.'
        }
      />
      {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
      <PrimaryButton
        label="I have verified my email"
        onPress={() => void checkVerified()}
        loading={checking}
      />
      <TextButton
        label={cooldown > 0 ? `Resend email in ${cooldown}s` : 'Resend email'}
        onPress={() => void resend()}
        disabled={resending || cooldown > 0}
      />
      <TextButton label="Use a different account" onPress={() => void signOut()} />
    </AuthFrame>
  );
}
