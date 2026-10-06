import { appName, type AuthScreenProps } from '../app-info';
import { BrandMark } from '../BrandMark';
import { AuthFrame, Heading, PrimaryButton, SecondaryButton } from '../components';
import { spacing } from '@ridemesh/ui';
import { View } from 'react-native';

export function WelcomeScreen({
  app,
  theme,
  onSignIn,
  onCreateAccount,
}: AuthScreenProps & { onSignIn: () => void; onCreateAccount: () => void }) {
  return (
    <AuthFrame theme={theme}>
      <View style={{ flex: 1, justifyContent: 'center', gap: spacing[6] }}>
        <BrandMark size={72} />
        <Heading title={appName(app)} subtitle="Sign in or create an account to get started." />
        <PrimaryButton label="Sign in" onPress={onSignIn} />
        <SecondaryButton label="Create account" onPress={onCreateAccount} />
      </View>
    </AuthFrame>
  );
}
