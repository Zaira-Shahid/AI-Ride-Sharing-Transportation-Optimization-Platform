import { cancelTripRequest, createTripRequest, describeAuthError } from '@ridemesh/firebase';
import { useAuth, useCurrentTripRequest } from '@ridemesh/firebase/react';
import { MapView, useCurrentLocation, type LocationStatus } from '@ridemesh/map';
import {
  checkChosenPlace,
  checkTripTimes,
  DEFAULT_FLEXIBILITY,
  DEFAULT_TRIP_TIMES,
  currentLocationPlace,
  flexibilityPreferences,
  type ChosenPlaceProblem,
  type Flexibility,
  type StoredDestination,
  type TripTimes,
} from '@ridemesh/types';
import { radius, spacing } from '@ridemesh/ui';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import type { AuthScreenProps } from '../app-info';
import {
  AuthThemeProvider,
  ConfirmDialog,
  Notice,
  PrimaryButton,
  SecondaryButton,
  TextButton,
  useAuthTheme,
} from '../components';
import { FlexibilityCard } from './FlexibilityCard';
import { PlaceRejectedError } from './PlaceSearch';
import { DestinationCard, PickupCard } from './TripPlaceCards';
import { RequestedCard, ReviewCard, type TripSummaryData } from './TripRequestCards';
import { TripTimeCard } from './TripTimeCard';
import { useNow } from './useNow';

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

// The cards on top take at most this share of the screen and scroll beyond it, so that the map keeps
// room for the places, the zoom buttons and the location button.
const TOP_CARDS_MAX_SHARE = 0.45;

// How often the screen looks at the clock again, so that times that have become too soon are noticed.
const NOW_REFRESH_MS = 30_000;

// A place that cannot be used, or that is the same place as the other one (a trip from a place to
// the same place is no trip), is refused, whichever of the two is being chosen. Both are decided by
// checkChosenPlace in @ridemesh/types.
const UNUSABLE_PLACE = 'That place cannot be used for a trip. Please choose another.';
const PICKUP_IS_DESTINATION =
  'Your pickup is the same place as your destination. Choose a different pickup.';
const DESTINATION_IS_PICKUP =
  'Your destination is the same place as your pickup. Choose a different destination.';

function refusal(problem: ChosenPlaceProblem, choosing: 'pickup' | 'destination'): string {
  if (problem === 'UNUSABLE') return UNUSABLE_PLACE;
  return choosing === 'pickup' ? PICKUP_IS_DESTINATION : DESTINATION_IS_PICKUP;
}

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
 * the button, one reading, never stored) or a place from the search. The passenger also says when:
 * leave now (the default) or at a time, and optionally a time to arrive by; and how flexible they
 * are: a level, and whether they will share and allow route changes. Everything is held only here,
 * in the app, until the passenger presses Request ride, looks over a summary and confirms: only then
 * is it sent, once, and the server checks it all again (Module 3.7). A pickup and a destination that
 * are the same place are refused. Once a request is open the screen shows it instead, with a button to
 * cancel it while it is still waiting to be matched.
 */
export function PassengerHomeScreen({
  theme,
  placesApiKey,
}: Pick<AuthScreenProps, 'theme'> & {
  /** The Maps Platform key for place search, when this build has one. */
  placesApiKey?: string | undefined;
}) {
  const { height } = useWindowDimensions();
  const { client } = useAuth();
  const tripRequest = useCurrentTripRequest();
  const [pickup, setPickup] = useState<StoredDestination | null>(null);
  const [destination, setDestination] = useState<StoredDestination | null>(null);
  const location = useCurrentLocation();
  const [times, setTimes] = useState<TripTimes>(DEFAULT_TRIP_TIMES);
  const [flexibility, setFlexibility] = useState<Flexibility>(DEFAULT_FLEXIBILITY);
  const now = useNow(NOW_REFRESH_MS);
  // Which button the passenger last pressed for the device's location, so that a problem with it
  // is shown next to that button and not twice.
  const [askedBy, setAskedBy] = useState<'map' | 'pickup' | null>(null);
  const [pickupFromLocation, setPickupFromLocation] = useState(false);
  const [pickupProblem, setPickupProblem] = useState<string | null>(null);
  // How much of the map the cards at the top and the button at the bottom cover.
  const [topCover, setTopCover] = useState(0);
  const [bottomCover, setBottomCover] = useState(0);
  const [reviewing, setReviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendProblem, setSendProblem] = useState<string | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelProblem, setCancelProblem] = useState<string | null>(null);

  const openTrip = tripRequest.status === 'ready' ? tripRequest.trip : null;

  const choosePickup = (place: StoredDestination) => {
    const problem = checkChosenPlace(place, destination);
    if (problem) throw new PlaceRejectedError(refusal(problem, 'pickup'));
    setPickupProblem(null);
    setPickup(place);
  };

  const chooseDestination = (place: StoredDestination) => {
    const problem = checkChosenPlace(place, pickup);
    if (problem) throw new PlaceRejectedError(refusal(problem, 'destination'));
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
      const problem = checkChosenPlace(here, destination);
      if (problem) setPickupProblem(refusal(problem, 'pickup'));
      else setPickup(here);
    } else if (location.status === 'denied' || location.status === 'unavailable') {
      setPickupFromLocation(false);
    }
  }, [pickupFromLocation, location.status, location.point, destination]);

  const locationProblem = LOCATION_PROBLEMS[location.status];

  const canRequest = pickup !== null && destination !== null && checkTripTimes(times, now) === null;

  const sendRequest = async () => {
    if (!pickup || !destination) return;
    setSending(true);
    setSendProblem(null);
    try {
      await createTripRequest(client, {
        origin: pickup,
        destination,
        departure: times.departure,
        arriveBy: times.arriveBy,
        preferences: flexibilityPreferences(flexibility),
      });
      // The open request now arrives through the live subscription and replaces the review.
      setReviewing(false);
    } catch (error) {
      setSendProblem(describeAuthError(error).message);
    } finally {
      setSending(false);
    }
  };

  const cancelRequest = async () => {
    if (!openTrip) return;
    setCancelling(true);
    setCancelProblem(null);
    try {
      await cancelTripRequest(client, openTrip.id);
    } catch (error) {
      setCancelProblem(describeAuthError(error).message);
    } finally {
      setCancelling(false);
      setConfirmingCancel(false);
    }
  };

  const reviewSummary: TripSummaryData | null =
    pickup && destination
      ? {
          pickup: pickup.formattedAddress,
          destination: destination.formattedAddress,
          departureAt: times.departure.kind === 'AT' ? times.departure.at : null,
          arriveBy: times.arriveBy,
          level: flexibility.level,
          allowSharedRide: flexibility.allowSharedRide,
        }
      : null;

  return (
    <AuthThemeProvider theme={theme}>
      <View style={[styles.screen, { backgroundColor: theme.background }]}>
        <View style={StyleSheet.absoluteFill}>
          <MapView
            pickup={openTrip ? openTrip.origin : pickup}
            destination={openTrip ? openTrip.destination : destination}
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
            style={{ maxHeight: height * TOP_CARDS_MAX_SHARE }}
            contentContainerStyle={styles.stack}
            keyboardShouldPersistTaps="handled"
          >
            {tripRequest.status === 'error' ? (
              <View style={styles.problem}>
                <Notice tone="error">
                  We could not check for a ride you have already requested.
                </Notice>
                <TextButton label="Try again" onPress={tripRequest.retry} />
              </View>
            ) : null}
            {openTrip ? (
              <RequestedCard
                summary={{
                  pickup: openTrip.origin.formattedAddress,
                  destination: openTrip.destination.formattedAddress,
                  departureAt: openTrip.departureAt,
                  arriveBy: openTrip.arriveBy,
                  level: openTrip.flexibilityLevel,
                  allowSharedRide: openTrip.allowSharedRide,
                }}
                now={now}
                cancellable={openTrip.status === 'REQUESTED'}
                problem={cancelProblem}
                onCancel={() => {
                  setCancelProblem(null);
                  setConfirmingCancel(true);
                }}
              />
            ) : tripRequest.status === 'loading' ? null : reviewing && reviewSummary ? (
              <ReviewCard
                summary={reviewSummary}
                now={now}
                sending={sending}
                problem={sendProblem}
                onConfirm={() => void sendRequest()}
                onBack={() => setReviewing(false)}
              />
            ) : (
              <>
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
                  problem={
                    pickupProblem ?? (askedBy === 'pickup' ? (locationProblem ?? null) : null)
                  }
                  onUseCurrentLocation={usePickupHere}
                  onPick={choosePickup}
                  onClear={() => {
                    setPickup(null);
                    setAskedBy((asked) => (asked === 'pickup' ? null : asked));
                  }}
                />
                <TripTimeCard times={times} now={now} onChange={setTimes} />
                <FlexibilityCard flexibility={flexibility} onChange={setFlexibility} />
              </>
            )}
          </ScrollView>
        </View>
        <View
          pointerEvents="box-none"
          style={styles.bottom}
          onLayout={(event) => setBottomCover(event.nativeEvent.layout.height)}
        >
          {!openTrip && !reviewing && tripRequest.status !== 'loading' ? (
            <PrimaryButton
              label="Request ride"
              onPress={() => {
                setSendProblem(null);
                setReviewing(true);
              }}
              disabled={!canRequest}
            />
          ) : null}
          <LocateButton
            status={location.status}
            problem={askedBy === 'map' ? locationProblem : undefined}
            onLocate={showMyLocation}
          />
        </View>
        <ConfirmDialog
          visible={confirmingCancel}
          title="Cancel your ride request?"
          message="You can request a ride again whenever you like."
          confirmLabel="Yes, cancel it"
          cancelLabel="Keep request"
          busy={cancelling}
          onConfirm={() => void cancelRequest()}
          onCancel={() => setConfirmingCancel(false)}
        />
      </View>
    </AuthThemeProvider>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  top: { position: 'absolute', top: 0, left: 0, right: 0, padding: spacing[4] },
  stack: { gap: spacing[3] },
  bottom: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: spacing[4],
    gap: spacing[3],
  },
  problem: { gap: spacing[1] },
  card: { borderWidth: 1, borderRadius: radius.lg, padding: spacing[4], gap: spacing[3] },
});
