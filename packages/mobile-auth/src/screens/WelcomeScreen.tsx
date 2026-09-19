import { appName, type AuthScreenProps } from '../app-info';
import { AuthFrame, Heading, PrimaryButton } from '../components';
import { spacing } from '@ridemesh/ui';
import { View } from 'react-native';

export function WelcomeScreen({
  app,
  theme,
  onCreateAccount,
}: AuthScreenProps & { onCreateAccount: () => void }) {
  return (
    <AuthFrame theme={theme}>
      <View style={{ flex: 1, justifyContent: 'center', gap: spacing[6] }}>
        <Heading title={appName(app)} subtitle="Create an account to get started." />
        <PrimaryButton label="Create account" onPress={onCreateAccount} />
      </View>
    </AuthFrame>
  );
}
