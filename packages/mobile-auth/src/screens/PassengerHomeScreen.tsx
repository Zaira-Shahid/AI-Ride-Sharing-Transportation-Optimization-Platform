import { MapView, useCurrentLocation, type LocationStatus } from '@ridemesh/map';
import type { StoredDestination } from '@ridemesh/types';
import { fontSize, fontWeight, radius, spacing } from '@ridemesh/ui';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { AuthScreenProps } from '../app-info';
import { AuthThemeProvider, Notice, SecondaryButton, useAuthTheme } from '../components';
import { PlaceSearch } from './PlaceSearch';

const LOCATION_LABELS: Record<LocationStatus, string> = {
  idle: 'Show my location',
  locating: 'Finding your location',
  ready: 'Update my location',
  denied: 'Show my location',
  unavailable: 'Show my location',
};

const LOCATION_PROBLEMS: Partial<Record<LocationStatus, string>> = {
  denied:
    'Location is turned off for this app. You can turn it on in your browser or phone settings.',
  unavailable: 'We could not find your location. Check your signal and try again.',
};

function WhereTo({
  placesApiKey,
  place,
  onPick,
  onClear,
}: {
  placesApiKey: string | undefined;
  place: StoredDestination | null;
  onPick: (place: StoredDestination) => void;
  onClear: () => void;
}) {
  const theme = useAuthTheme();
  const card = [styles.card, { backgroundColor: theme.surface, borderColor: theme.border }];

  return (
    <View style={card} accessibilityLabel="Where to">
      <Text accessibilityRole="header" style={[styles.title, { color: theme.textPrimary }]}>
        Where are you going?
      </Text>
      <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled">
        {place ? (
          <View style={styles.picked}>
            <View style={styles.current}>
              <Text style={[styles.caption, { color: theme.textSecondary }]}>Heading to</Text>
              <Text style={[styles.address, { color: theme.textPrimary }]}>
                {place.formattedAddress}
              </Text>
            </View>
            <SecondaryButton label="Change destination" onPress={onClear} />
          </View>
        ) : (
          <PlaceSearch
            placesApiKey={placesApiKey}
            label="Search for a destination"
            onPick={onPick}
            busyLabel="Getting the place"
          />
        )}
      </ScrollView>
    </View>
  );
}

function LocateButton({ status, onLocate }: { status: LocationStatus; onLocate: () => void }) {
  const theme = useAuthTheme();
  const problem = LOCATION_PROBLEMS[status];
  return (
    <View
      style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}
      accessibilityLabel="Your location"
    >
      {problem ? <Notice tone="error">{problem}</Notice> : null}
      <SecondaryButton
        label={LOCATION_LABELS[status]}
        onPress={onLocate}
        disabled={status === 'locating'}
      />
    </View>
  );
}

/**
 * The passenger's Home: a map that fills the screen, with the search for where they are going on top
 * and a button to show where they are at the bottom. The place picked is marked on the map. It, and
 * the device's location (asked for only when the passenger taps the button, one reading, never
 * stored), are only held here, in the app: nothing is sent to the server until the trip request is
 * submitted (Module 3.7), and the pickup, time and flexibility are added by the modules that follow.
 */
export function PassengerHomeScreen({
  theme,
  placesApiKey,
}: Pick<AuthScreenProps, 'theme'> & {
  /** The Maps Platform key for place search, when this build has one. */
  placesApiKey?: string | undefined;
}) {
  const [place, setPlace] = useState<StoredDestination | null>(null);
  const location = useCurrentLocation();

  return (
    <AuthThemeProvider theme={theme}>
      <View style={[styles.screen, { backgroundColor: theme.background }]}>
        <View style={StyleSheet.absoluteFill}>
          <MapView destination={place} currentLocation={location.point} />
        </View>
        <View pointerEvents="box-none" style={styles.top}>
          <WhereTo
            placesApiKey={placesApiKey}
            place={place}
            onPick={setPlace}
            onClear={() => setPlace(null)}
          />
        </View>
        <View pointerEvents="box-none" style={styles.bottom}>
          <LocateButton status={location.status} onLocate={location.locate} />
        </View>
      </View>
    </AuthThemeProvider>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  top: { position: 'absolute', top: 0, left: 0, right: 0, padding: spacing[4] },
  bottom: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: spacing[4] },
  card: { borderWidth: 1, borderRadius: radius.lg, padding: spacing[4], gap: spacing[3] },
  scroll: { maxHeight: 360 },
  title: { fontSize: fontSize.lg, fontWeight: fontWeight.semibold },
  picked: { gap: spacing[3] },
  caption: { fontSize: fontSize.sm },
  current: { gap: spacing[1] },
  address: { fontSize: fontSize.base, fontWeight: fontWeight.medium },
});
