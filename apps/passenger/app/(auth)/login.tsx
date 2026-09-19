import { LoginScreen } from '@ridemesh/mobile-auth';
import { useRouter } from 'expo-router';
import { theme } from '../../src/theme';

export default function Login() {
  const router = useRouter();
  return (
    <LoginScreen
      app="passenger"
      theme={theme}
      onCreateAccount={() => router.replace('/register')}
      onForgotPassword={() => router.push('/forgot-password')}
    />
  );
}
