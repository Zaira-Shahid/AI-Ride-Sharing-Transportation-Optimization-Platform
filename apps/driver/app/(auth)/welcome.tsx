import { WelcomeScreen } from '@ridemesh/mobile-auth';
import { useRouter } from 'expo-router';
import { theme } from '../../src/theme';

export default function Welcome() {
  const router = useRouter();
  return (
    <WelcomeScreen
      app="driver"
      theme={theme}
      onSignIn={() => router.push('/login')}
      onCreateAccount={() => router.push('/register')}
    />
  );
}
