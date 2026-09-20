import { useAuth } from '@ridemesh/firebase/react';
import { Redirect, Stack, useSegments } from 'expo-router';

export const unstable_settings = { initialRouteName: 'welcome' };

export default function AuthLayout() {
  const { status } = useAuth();
  const segments: string[] = useSegments();
  // A signed-in account with no role (its set-up was never finished) belongs on Register, which
  // finishes it. Left alone it would stay on whichever screen it signed in from, with no message.
  if (status === 'incomplete' && segments[segments.length - 1] !== 'register') {
    return <Redirect href="/register" />;
  }
  return <Stack screenOptions={{ headerShown: false }} />;
}
