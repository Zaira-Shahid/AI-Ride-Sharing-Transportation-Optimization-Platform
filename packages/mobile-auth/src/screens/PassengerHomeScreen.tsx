import { MapView, useCurrentLocation, type LocationStatus } from '@ridemesh/map';
import { currentLocationPlace, isSamePlace, type StoredDestination } from '@ridemesh/types';
import { radius, spacing } from '@ridemesh/ui';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import type { AuthScreenProps } from '../app-info';
import { AuthThemeProvider, Notice, SecondaryButton, useAuthTheme } from '../components';
import { PlaceRejectedError } from './PlaceSearch';
import { DestinationCard, PickupCard } from './TripPlaceCards';

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

// A trip from a place to the same place is no trip, so it is refused, whichever of the two is being
// chosen. "The same place" is decided by isSamePlace in @ridemesh/types.
const PICKUP_IS_DESTINATION =
  'Your pickup is the same place as your destination. Choose a different pickup.';
const DESTINATION_IS_PICKUP =
  'Your destination is the same place as your pickup. Choose a different destination.';

function LocateButton({
  status,
  problem,
  onLocate,
}: {
  status: LocationStatus;
  problem: string | undefined;
  onLocate: () => void;
}) {
  const theme = useAuthTheme();
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
 * The passenger's Home: a map that fills the screen, with where they are going and where they will
 * be picked up on top, and a button to show where they are at the bottom. The places chosen are
 * marked on the map. The pickup can be the device's location (asked for only when the passenger taps
 * the button, one reading, never stored) or a place from the search. Everything is held only here, in
 * the app: nothing is sent to the server until the trip request is submitted (Module 3.7); the
 * time and flexibility are added by the modules that follow. A pickup and a destination that are
 * the same place are refused.
 */
export function PassengerHomeScreen({
  theme,
  placesApiKey,
}: Pick<AuthScreenProps, 'theme'> & {
  /** The Maps Platform key for place search, when this build has one. */
  placesApiKey?: string | undefined;
}) {
  const { height } = useWindowDimensions();
  const [pickup, setPickup] = useState<StoredDestination | null>(null);
  const [destination, setDestination] = useState<StoredDestination | null>(null);
  const location = useCurrentLocation();
  // Which button the passenger last pressed for the device's location, so that a problem with it
  // is shown next to that button and not twice.
  const [askedBy, setAskedBy] = useState<'map' | 'pickup' | null>(null);
  const [pickupFromLocation, setPickupFromLocation] = useState(false);
  const [pickupProblem, setPickupProblem] = useState<string | null>(null);
  // How much of the map the cards at the top and the button at the bottom cover.
  const [topCover, setTopCover] = useState(0);
  const [bottomCover, setBottomCover] = useState(0);

  const choosePickup = (place: StoredDestination) => {
    if (destination && isSamePlace(place, destination)) {
      throw new PlaceRejectedError(PICKUP_IS_DESTINATION);
    }
    setPickupProblem(null);
    setPickup(place);
  };

  const chooseDestination = (place: StoredDestination) => {
    if (pickup && isSamePlace(place, pickup)) throw new PlaceRejectedError(DESTINATION_IS_PICKUP);
    setDestination(place);
  };

  const usePickupHere = () => {
    setPickupProblem(null);
    setAskedBy('pickup');
    setPickupFromLocation(true);
    location.locate();
  };

  const showMyLocation = () => {
    setAskedBy('map');
    location.locate();
  };

  // When the device's location arrives for a pickup, that is the pickup (unless it is the destination).
  useEffect(() => {
    if (!pickupFromLocation) return;
    if (location.status === 'ready' && location.point) {
      setPickupFromLocation(false);
      const here = currentLocationPlace(location.point);
      if (destination && isSamePlace(here, destination)) setPickupProblem(PICKUP_IS_DESTINATION);
      else setPickup(here);
    } else if (location.status === 'denied' || location.status === 'unavailable') {
      setPickupFromLocation(false);
    }
  }, [pickupFromLocation, location.status, location.point, destination]);

  const locationProblem = LOCATION_PROBLEMS[location.status];

  return (
    <AuthThemeProvider theme={theme}>
      <View style={[styles.screen, { backgroundColor: theme.background }]}>
        <View style={StyleSheet.absoluteFill}>
          <MapView
            pickup={pickup}
            destination={destination}
            currentLocation={location.point}
            insets={{ top: topCover, bottom: bottomCover }}
          />
        </View>
        <View
          pointerEvents="box-none"
          style={styles.top}
          onLayout={(event) => setTopCover(event.nativeEvent.layout.height)}
        >
          <ScrollView
            style={{ maxHeight: height * 0.62 }}
            contentContainerStyle={styles.stack}
            keyboardShouldPersistTaps="handled"
          >
            <DestinationCard
              placesApiKey={placesApiKey}
              destination={destination}
              onPick={chooseDestination}
              onClear={() => setDestination(null)}
            />
            <PickupCard
              placesApiKey={placesApiKey}
              pickup={pickup}
              locating={pickupFromLocation && location.status === 'locating'}
              problem={pickupProblem ?? (askedBy === 'pickup' ? (locationProblem ?? null) : null)}
              onUseCurrentLocation={usePickupHere}
              onPick={choosePickup}
              onClear={() => {
                setPickup(null);
                setAskedBy((asked) => (asked === 'pickup' ? null : asked));
              }}
            />
          </ScrollView>
        </View>
        <View
          pointerEvents="box-none"
          style={styles.bottom}
          onLayout={(event) => setBottomCover(event.nativeEvent.layout.height)}
        >
          <LocateButton
            status={location.status}
            problem={askedBy === 'map' ? locationProblem : undefined}
            onLocate={showMyLocation}
          />
        </View>
      </View>
    </AuthThemeProvider>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  top: { position: 'absolute', top: 0, left: 0, right: 0, padding: spacing[4] },
  stack: { gap: spacing[3] },
  bottom: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: spacing[4] },
  card: { borderWidth: 1, borderRadius: radius.lg, padding: spacing[4], gap: spacing[3] },
});
