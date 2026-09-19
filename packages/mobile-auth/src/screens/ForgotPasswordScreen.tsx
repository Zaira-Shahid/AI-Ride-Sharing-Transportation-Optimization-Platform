import { describeAuthError, requestPasswordReset, type AuthFailure } from '@ridemesh/firebase';
import { useAuth } from '@ridemesh/firebase/react';
import { validatePasswordResetRequest } from '@ridemesh/types';
import { useEffect, useState } from 'react';
import type { AuthScreenProps } from '../app-info';
import { AuthFrame, Heading, Notice, PrimaryButton, TextButton, TextField } from '../components';

const RESEND_COOLDOWN_SECONDS = 60;

export function ForgotPasswordScreen({
  theme,
  onBackToSignIn,
}: AuthScreenProps & { onBackToSignIn: () => void }) {
  const { client } = useAuth();
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | undefined>();
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((seconds) => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const submit = async () => {
    setFailure(null);
    const validation = validatePasswordResetRequest({ email });
    if (!validation.ok) {
      setEmailError(validation.errors.email);
      return;
    }
    setEmailError(undefined);
    setSubmitting(true);
    try {
      await requestPasswordReset(client, { email });
      setSentTo(validation.data.email);
      setCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (error) {
      const described = describeAuthError(error);
      setFailure(described);
      if (described.kind === 'invalid-email') setEmailError(described.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (sentTo) {
    return (
      <AuthFrame theme={theme}>
        <Heading title="Check your email" />
        <Notice tone="info">
          {`If an account exists for ${sentTo}, we sent an email with a link to reset your password. Open it, choose a new password, then come back here and sign in.`}
        </Notice>
        {failure ? <Notice tone="error">{failure.message}</Notice> : null}
        <PrimaryButton label="Back to sign in" onPress={onBackToSignIn} />
        <TextButton
          label={cooldown > 0 ? `Send again in ${cooldown}s` : 'Send again'}
          onPress={() => void submit()}
          disabled={submitting || cooldown > 0}
        />
      </AuthFrame>
    );
  }

  return (
    <AuthFrame theme={theme}>
      <Heading
        title="Reset your password"
        subtitle="Enter the email address you signed up with and we will send you a link."
      />
      {failure && failure.kind !== 'invalid-email' ? (
        <Notice tone="error">{failure.message}</Notice>
      ) : null}
      <TextField
        label="Email"
        value={email}
        onChangeText={(value) => {
          setEmail(value);
          setEmailError(undefined);
        }}
        error={emailError}
        autoComplete="email"
        textContentType="emailAddress"
        keyboardType="email-address"
        autoCapitalize="none"
        returnKeyType="done"
        onSubmitEditing={() => void submit()}
        editable={!submitting}
      />
      <PrimaryButton
        label={submitting ? 'Sending' : failure?.retryable ? 'Try again' : 'Send reset link'}
        onPress={() => void submit()}
        loading={submitting}
      />
      <TextButton label="Back to sign in" onPress={onBackToSignIn} disabled={submitting} />
    </AuthFrame>
  );
}
