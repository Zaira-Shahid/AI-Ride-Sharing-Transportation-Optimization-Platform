import type { StoredDestination } from '@ridemesh/types';
import { fontSize, fontWeight, radius, spacing } from '@ridemesh/ui';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { AuthScreenProps } from '../app-info';
import { AuthFrame, Heading, SecondaryButton, useAuthTheme } from '../components';
import { PlaceSearch } from './PlaceSearch';

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
      {place ? (
        <>
          <View style={styles.current}>
            <Text style={[styles.caption, { color: theme.textSecondary }]}>Heading to</Text>
            <Text style={[styles.address, { color: theme.textPrimary }]}>
              {place.formattedAddress}
            </Text>
          </View>
          <SecondaryButton label="Change destination" onPress={onClear} />
        </>
      ) : (
        <PlaceSearch
          placesApiKey={placesApiKey}
          label="Search for a destination"
          onPick={onPick}
          busyLabel="Getting the place"
        />
      )}
    </View>
  );
}

/**
 * The passenger's Home: where are you going? The passenger searches for a place with Google Places
 * and the place picked is shown. It is only held here, in the app: nothing is sent to the server
 * until the trip request is submitted (Module 3.7), and the pickup, time and flexibility are added
 * by the modules that follow.
 */
export function PassengerHomeScreen({
  theme,
  placesApiKey,
}: Pick<AuthScreenProps, 'theme'> & {
  /** The Maps Platform key for place search, when this build has one. */
  placesApiKey?: string | undefined;
}) {
  const [place, setPlace] = useState<StoredDestination | null>(null);

  return (
    <AuthFrame theme={theme} insets={false}>
      <Heading title="Where are you going?" />
      <WhereTo
        placesApiKey={placesApiKey}
        place={place}
        onPick={setPlace}
        onClear={() => setPlace(null)}
      />
    </AuthFrame>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: radius.lg, padding: spacing[6], gap: spacing[3] },
  caption: { fontSize: fontSize.sm },
  current: { gap: spacing[1] },
  address: { fontSize: fontSize.base, fontWeight: fontWeight.medium },
});
