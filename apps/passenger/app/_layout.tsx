import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from '@expo-google-fonts/inter';
import { AuthProvider, useAuth } from '@ridemesh/firebase/react';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, View } from 'react-native';
import { getFirebaseClient } from '../src/firebase';
import { theme } from '../src/theme';

const client = getFirebaseClient();

function Navigator() {
  const { status } = useAuth();
  // Nothing is drawn until Inter is ready, so text never flashes in another font. A font that fails to
  // load (an error) lets the app carry on in the system font instead of waiting for ever.
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  if (status === 'loading' || (!fontsLoaded && !fontError)) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.background,
        }}
      >
        <ActivityIndicator accessibilityLabel="Loading" color={theme.accent} />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={status === 'signedOut' || status === 'incomplete'}>
        <Stack.Screen name="(auth)" />
      </Stack.Protected>
      <Stack.Protected guard={status === 'unverified'}>
        <Stack.Screen name="verify-email" />
      </Stack.Protected>
      <Stack.Protected guard={status === 'ready'}>
        <Stack.Screen name="(tabs)" />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider client={client}>
      <StatusBar style="dark" />
      <Navigator />
    </AuthProvider>
  );
}
