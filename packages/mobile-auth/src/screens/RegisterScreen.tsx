import { describeAuthError, registerAccount, type AuthFailure } from '@ridemesh/firebase';
import { useAuth } from '@ridemesh/firebase/react';
import {
  validateRegistration,
  type RegistrationField,
  type RegistrationFormValues,
} from '@ridemesh/types';
import { useRef, useState } from 'react';
import { type TextInput } from 'react-native';
import { ROLE_BY_APP, appName, type AuthScreenProps } from '../app-info';
import { AuthFrame, Heading, Notice, PrimaryButton, TextButton, TextField } from '../components';

type FieldErrors = Partial<Record<RegistrationField, string>>;

const EMPTY: RegistrationFormValues = {
  name: '',
  email: '',
  phone: '',
  password: '',
  confirmPassword: '',
};

export function RegisterScreen({
  app,
  theme,
  onSignIn,
}: AuthScreenProps & { onSignIn: () => void }) {
  const { client, runAuthFlow, status } = useAuth();
  const [values, setValues] = useState<RegistrationFormValues>(EMPTY);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const emailRef = useRef<TextInput>(null);
  const phoneRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);
  const confirmRef = useRef<TextInput>(null);

  const set = (field: RegistrationField) => (value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
  };

  const submit = async () => {
    setFailure(null);
    const validation = validateRegistration(values);
    if (!validation.ok) {
      setFieldErrors(validation.errors);
      return;
    }
    setFieldErrors({});
    setSubmitting(true);
    try {
      await runAuthFlow(() => registerAccount(client, { role: ROLE_BY_APP[app], values }));
    } catch (error) {
      const described = describeAuthError(error);
      setFailure(described);
      if (described.kind === 'email-in-use') setFieldErrors({ email: described.message });
      if (described.kind === 'invalid-email') setFieldErrors({ email: described.message });
      if (described.kind === 'weak-password') setFieldErrors({ password: described.message });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthFrame theme={theme}>
      <Heading title="Create your account" subtitle={appName(app)} />

      {status === 'incomplete' ? (
        <Notice tone="info">
          Your email is verified, but your account setup was not finished. Enter your details again
          to continue.
        </Notice>
      ) : null}
      {failure && failure.kind !== 'email-in-use' ? (
        <Notice tone="error">{failure.message}</Notice>
      ) : null}

      <TextField
        label="Full name"
        value={values.name}
        onChangeText={set('name')}
        error={fieldErrors.name}
        autoComplete="name"
        textContentType="name"
        autoCapitalize="words"
        returnKeyType="next"
        onSubmitEditing={() => emailRef.current?.focus()}
        editable={!submitting}
      />
      <TextField
        label="Email"
        value={values.email}
        onChangeText={set('email')}
        error={fieldErrors.email}
        inputRef={emailRef}
        autoComplete="email"
        textContentType="emailAddress"
        keyboardType="email-address"
        autoCapitalize="none"
        returnKeyType="next"
        onSubmitEditing={() => phoneRef.current?.focus()}
        editable={!submitting}
      />
      <TextField
        label="Phone number (optional)"
        value={values.phone}
        onChangeText={set('phone')}
        error={fieldErrors.phone}
        inputRef={phoneRef}
        autoComplete="tel"
        textContentType="telephoneNumber"
        keyboardType="phone-pad"
        returnKeyType="next"
        onSubmitEditing={() => passwordRef.current?.focus()}
        editable={!submitting}
      />
      <TextField
        label="Password"
        value={values.password}
        onChangeText={set('password')}
        error={fieldErrors.password}
        hint="At least 8 characters."
        inputRef={passwordRef}
        secure
        autoComplete="new-password"
        textContentType="newPassword"
        autoCapitalize="none"
        returnKeyType="next"
        onSubmitEditing={() => confirmRef.current?.focus()}
        editable={!submitting}
      />
      <TextField
        label="Confirm password"
        value={values.confirmPassword}
        onChangeText={set('confirmPassword')}
        error={fieldErrors.confirmPassword}
        inputRef={confirmRef}
        secure
        autoComplete="new-password"
        textContentType="newPassword"
        autoCapitalize="none"
        returnKeyType="done"
        onSubmitEditing={() => void submit()}
        editable={!submitting}
      />

      <PrimaryButton
        label={
          submitting ? 'Creating account' : failure?.retryable ? 'Try again' : 'Create account'
        }
        onPress={() => void submit()}
        loading={submitting}
      />
      <TextButton
        label="Already have an account? Sign in"
        onPress={onSignIn}
        disabled={submitting}
      />
    </AuthFrame>
  );
}
