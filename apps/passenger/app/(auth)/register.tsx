import { RegisterScreen } from '@ridemesh/mobile-auth';
import { useRouter } from 'expo-router';
import { theme } from '../../src/theme';

export default function Register() {
  const router = useRouter();
  return <RegisterScreen app="passenger" theme={theme} onSignIn={() => router.replace('/login')} />;
}
