import { ForgotPasswordScreen } from '@ridemesh/mobile-auth';
import { useRouter } from 'expo-router';
import { theme } from '../../src/theme';

export default function ForgotPassword() {
  const router = useRouter();
  return (
    <ForgotPasswordScreen
      app="driver"
      theme={theme}
      onBackToSignIn={() => (router.canGoBack() ? router.back() : router.replace('/login'))}
    />
  );
}
