import type { StoredDestination } from '@ridemesh/types';
import { fontSize, fontWeight, radius, spacing } from '@ridemesh/ui';
import { StyleSheet, Text, View } from 'react-native';
import { Notice, SecondaryButton, useAuthTheme } from '../components';
import { PlaceSearch } from './PlaceSearch';

function useCardStyle() {
  const theme = useAuthTheme();
  return [styles.card, { backgroundColor: theme.surface, borderColor: theme.border }];
}

/** A chosen place: the caption, its address and a button to choose another. */
function ChosenPlace({
  caption,
  place,
  changeLabel,
  onChange,
}: {
  caption: string;
  place: StoredDestination;
  changeLabel: string;
  onChange: () => void;
}) {
  const theme = useAuthTheme();
  return (
    <View style={styles.chosen}>
      <View style={styles.current}>
        <Text style={[styles.caption, { color: theme.textSecondary }]}>{caption}</Text>
        <Text style={[styles.address, { color: theme.textPrimary }]}>{place.formattedAddress}</Text>
      </View>
      <SecondaryButton label={changeLabel} onPress={onChange} />
    </View>
  );
}

/** Where the passenger is going: the place chosen, or the search for one. */
export function DestinationCard({
  placesApiKey,
  destination,
  onPick,
  onClear,
}: {
  placesApiKey: string | undefined;
  destination: StoredDestination | null;
  /** May throw a PlaceRejectedError to refuse the place. */
  onPick: (place: StoredDestination) => void;
  onClear: () => void;
}) {
  const theme = useAuthTheme();
  return (
    <View style={useCardStyle()} accessibilityLabel="Where to">
      <Text accessibilityRole="header" style={[styles.title, { color: theme.textPrimary }]}>
        Where are you going?
      </Text>
      {destination ? (
        <ChosenPlace
          caption="Heading to"
          place={destination}
          changeLabel="Change destination"
          onChange={onClear}
        />
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
 * Where the passenger will be picked up: the place chosen, or two ways to choose one: the device's
 * location (when the passenger taps the button, never before) or a search. A pickup taken from the
 * device's location has no address to show, so it says "Current location".
 */
export function PickupCard({
  placesApiKey,
  pickup,
  locating,
  problem,
  onUseCurrentLocation,
  onPick,
  onClear,
}: {
  placesApiKey: string | undefined;
  pickup: StoredDestination | null;
  /** Waiting for the device's location for the pickup. */
  locating: boolean;
  /** Why the pickup could not be taken from the device's location, if it could not. */
  problem: string | null;
  onUseCurrentLocation: () => void;
  /** May throw a PlaceRejectedError to refuse the place. */
  onPick: (place: StoredDestination) => void;
  onClear: () => void;
}) {
  const theme = useAuthTheme();
  return (
    <View style={useCardStyle()} accessibilityLabel="Pickup">
      <Text accessibilityRole="header" style={[styles.title, { color: theme.textPrimary }]}>
        Where should we pick you up?
      </Text>
      {pickup ? (
        <ChosenPlace
          caption="Picking up at"
          place={pickup}
          changeLabel="Change pickup"
          onChange={onClear}
        />
      ) : (
        <>
          {problem ? <Notice tone="error">{problem}</Notice> : null}
          <SecondaryButton
            label={locating ? 'Finding your pickup' : 'Use my current location'}
            onPress={onUseCurrentLocation}
            disabled={locating}
          />
          <PlaceSearch
            placesApiKey={placesApiKey}
            label="Search for a pickup"
            onPick={onPick}
            busyLabel="Getting the place"
          />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: radius.lg, padding: spacing[4], gap: spacing[3] },
  title: { fontSize: fontSize.lg, fontWeight: fontWeight.semibold },
  chosen: { gap: spacing[3] },
  current: { gap: spacing[1] },
  caption: { fontSize: fontSize.sm },
  address: { fontSize: fontSize.base, fontWeight: fontWeight.medium },
});
