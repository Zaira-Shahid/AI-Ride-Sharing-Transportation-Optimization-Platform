import { PassengerHomeScreen } from '@ridemesh/mobile-auth';
import { theme } from '../../src/theme';

// Expo only inlines variables that are referenced literally.
const placesApiKey = process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY?.trim() || undefined;

export default function HomeScreen() {
  return <PassengerHomeScreen theme={theme} placesApiKey={placesApiKey} />;
}
