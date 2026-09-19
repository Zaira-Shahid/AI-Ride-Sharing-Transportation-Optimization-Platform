import { describeAuthError, signIn, type AuthFailure } from '@ridemesh/firebase';
import { useAuth } from '@ridemesh/firebase/react';
import { validateLogin, type LoginField, type LoginFormValues } from '@ridemesh/types';
import { useRef, useState } from 'react';
import { type TextInput } from 'react-native';
import { ROLE_BY_APP, appName, type AuthScreenProps } from '../app-info';
import { AuthFrame, Heading, Notice, PrimaryButton, TextButton, TextField } from '../components';

type FieldErrors = Partial<Record<LoginField, string>>;

export function LoginScreen({
  app,
  theme,
  onCreateAccount,
  onForgotPassword,
}: AuthScreenProps & { onCreateAccount: () => void; onForgotPassword: () => void }) {
  const { client, runAuthFlow } = useAuth();
  const [values, setValues] = useState<LoginFormValues>({ email: '', password: '' });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const passwordRef = useRef<TextInput>(null);

  const set = (field: LoginField) => (value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
  };

  const submit = async () => {
    setFailure(null);
    const validation = validateLogin(values);
    if (!validation.ok) {
      setFieldErrors(validation.errors);
      return;
    }
    setFieldErrors({});
    setSubmitting(true);
    try {
      await runAuthFlow(() => signIn(client, { values, expectedRole: ROLE_BY_APP[app] }));
    } catch (error) {
      const described = describeAuthError(error);
      setFailure(described);
      if (described.kind === 'invalid-email') setFieldErrors({ email: described.message });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthFrame theme={theme}>
      <Heading title="Welcome back" subtitle={appName(app)} />

      {failure && failure.kind !== 'invalid-email' ? (
        <Notice tone="error">{failure.message}</Notice>
      ) : null}

      <TextField
        label="Email"
        value={values.email}
        onChangeText={set('email')}
        error={fieldErrors.email}
        autoComplete="email"
        textContentType="emailAddress"
        keyboardType="email-address"
        autoCapitalize="none"
        returnKeyType="next"
        onSubmitEditing={() => passwordRef.current?.focus()}
        editable={!submitting}
      />
      <TextField
        label="Password"
        value={values.password}
        onChangeText={set('password')}
        error={fieldErrors.password}
        inputRef={passwordRef}
        secure
        autoComplete="current-password"
        textContentType="password"
        autoCapitalize="none"
        returnKeyType="done"
        onSubmitEditing={() => void submit()}
        editable={!submitting}
      />

      <PrimaryButton
        label={submitting ? 'Signing in' : failure?.retryable ? 'Try again' : 'Sign in'}
        onPress={() => void submit()}
        loading={submitting}
      />
      <TextButton label="Forgot password?" onPress={onForgotPassword} disabled={submitting} />
      <TextButton
        label={`New to ${appName(app)}? Create account`}
        onPress={onCreateAccount}
        disabled={submitting}
      />
    </AuthFrame>
  );
}
