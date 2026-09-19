import { useAuth } from '@ridemesh/firebase/react';
import { fontSize, fontWeight, radius, spacing } from '@ridemesh/ui';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { appName, type AuthScreenProps } from '../app-info';
import { AuthFrame, ConfirmDialog, Notice, SecondaryButton, useAuthTheme } from '../components';

function AccountCard() {
  const theme = useAuthTheme();
  const { user } = useAuth();
  const email = user?.email ?? '';
  const name = user?.displayName || email;
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
    </View>
  );
}

export function ProfileScreen({ app, theme }: AuthScreenProps) {
  const { signOut } = useAuth();
  const [confirming, setConfirming] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [failed, setFailed] = useState(false);

  const confirmSignOut = async () => {
    setFailed(false);
    setSigningOut(true);
    try {
      await signOut();
    } catch {
      setFailed(true);
      setConfirming(false);
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <AuthFrame theme={theme} insets={false}>
      <AccountCard />
      {failed ? <Notice tone="error">We could not sign you out. Please try again.</Notice> : null}
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
