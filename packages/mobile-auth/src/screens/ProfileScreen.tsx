import {
  describeAuthError,
  saveProfile,
  type AuthFailure,
  type ProfileData,
} from '@ridemesh/firebase';
import { useAuth, useProfile } from '@ridemesh/firebase/react';
import {
  validateProfileUpdate,
  type ProfileField,
  type ProfileUpdateValues,
} from '@ridemesh/types';
import { fontSize, fontWeight, radius, spacing } from '@ridemesh/ui';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { appName, type AuthScreenProps, type MobileApp } from '../app-info';
import {
  AuthFrame,
  ConfirmDialog,
  Notice,
  PrimaryButton,
  SecondaryButton,
  TextField,
  useAuthTheme,
} from '../components';

const DRIVER_PHONE_HINT = "You'll need to add a phone number before accepting rides.";

type FieldErrors = Partial<Record<ProfileField, string>>;

function AccountCard({ profile }: { profile?: ProfileData }) {
  const theme = useAuthTheme();
  const { user } = useAuth();
  // Firestore is the source of truth; the Auth details cover the moment before it has loaded.
  const email = profile?.email || user?.email || '';
  const name = profile?.name || user?.displayName || email;
  return (
    <View
      style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}
      accessibilityLabel="Signed-in account"
    >
      <Text style={[styles.caption, { color: theme.textSecondary }]}>Signed in as</Text>
      <Text style={[styles.name, { color: theme.textPrimary }]}>{name}</Text>
      {name !== email ? (
        <Text style={[styles.caption, { color: theme.textSecondary }]}>{email}</Text>
      ) : null}
      <Text style={[styles.caption, { color: theme.textSecondary }]}>
        Your email address cannot be changed here.
      </Text>
    </View>
  );
}

function DetailsForm({ app, profile }: { app: MobileApp; profile: ProfileData }) {
  const { client } = useAuth();
  const savedName = profile.name;
  const savedPhone = profile.phone ?? '';
  const [values, setValues] = useState<ProfileUpdateValues>({ name: savedName, phone: savedPhone });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  // Follow the stored profile until the person starts editing, so a change made elsewhere shows up.
  const lastSaved = useRef({ name: savedName, phone: savedPhone });
  useEffect(() => {
    const previous = lastSaved.current;
    if (previous.name === savedName && previous.phone === savedPhone) return;
    setValues((current) => ({
      name: current.name === previous.name ? savedName : current.name,
      phone: current.phone === previous.phone ? savedPhone : current.phone,
    }));
    lastSaved.current = { name: savedName, phone: savedPhone };
  }, [savedName, savedPhone]);

  const dirty = values.name.trim() !== savedName || values.phone.trim() !== savedPhone;

  const set = (field: ProfileField) => (value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
    setJustSaved(false);
    setFailure(null);
  };

  const save = async () => {
    setFailure(null);
    setJustSaved(false);
    const validation = validateProfileUpdate(values);
    if (!validation.ok) {
      setFieldErrors(validation.errors);
      return;
    }
    setFieldErrors({});
    setSaving(true);
    try {
      await saveProfile(client, values);
      setJustSaved(true);
    } catch (error) {
      setFailure(describeAuthError(error));
    } finally {
      setSaving(false);
    }
  };

  const showDriverHint = app === 'driver' && profile.phone === null;

  return (
    <>
      {justSaved ? <Notice tone="info">Your details have been saved.</Notice> : null}
      {failure ? <Notice tone="error">{failure.message}</Notice> : null}
      <TextField
        label="Full name"
        value={values.name}
        onChangeText={set('name')}
        error={fieldErrors.name}
        autoComplete="name"
        textContentType="name"
        autoCapitalize="words"
        returnKeyType="next"
        editable={!saving}
      />
      <TextField
        label={app === 'driver' ? 'Phone number' : 'Phone number (optional)'}
        value={values.phone}
        onChangeText={set('phone')}
        error={fieldErrors.phone}
        hint={showDriverHint ? DRIVER_PHONE_HINT : undefined}
        autoComplete="tel"
        textContentType="telephoneNumber"
        keyboardType="phone-pad"
        returnKeyType="done"
        onSubmitEditing={() => void save()}
        editable={!saving}
      />
      <PrimaryButton
        label={saving ? 'Saving' : failure?.retryable ? 'Try again' : 'Save changes'}
        onPress={() => void save()}
        loading={saving}
        disabled={!dirty}
      />
    </>
  );
}

export function ProfileScreen({ app, theme }: AuthScreenProps) {
  const { signOut } = useAuth();
  const profile = useProfile();
  const [confirming, setConfirming] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);

  const confirmSignOut = async () => {
    setSignOutFailed(false);
    setSigningOut(true);
    try {
      await signOut();
    } catch {
      setSignOutFailed(true);
      setConfirming(false);
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <AuthFrame theme={theme} insets={false}>
      <AccountCard {...(profile.status === 'ready' ? { profile: profile.profile } : {})} />

      {profile.status === 'loading' ? (
        <ActivityIndicator accessibilityLabel="Loading your details" color={theme.accent} />
      ) : null}
      {profile.status === 'ready' ? <DetailsForm app={app} profile={profile.profile} /> : null}
      {profile.status === 'missing' || profile.status === 'error' ? (
        <>
          <Notice tone="error">We could not load your profile details. Please try again.</Notice>
          <SecondaryButton label="Try again" onPress={profile.retry} />
        </>
      ) : null}

      {signOutFailed ? (
        <Notice tone="error">We could not sign you out. Please try again.</Notice>
      ) : null}
      <SecondaryButton label="Sign out" onPress={() => setConfirming(true)} />
      <ConfirmDialog
        visible={confirming}
        title="Sign out?"
        message={`You will need to sign in again to use ${appName(app)}.`}
        confirmLabel="Yes, sign out"
        busy={signingOut}
        onConfirm={() => void confirmSignOut()}
        onCancel={() => setConfirming(false)}
      />
    </AuthFrame>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: radius.lg, padding: spacing[6], gap: spacing[1] },
  caption: { fontSize: fontSize.sm },
  name: { fontSize: fontSize.xl, fontWeight: fontWeight.semibold },
});
