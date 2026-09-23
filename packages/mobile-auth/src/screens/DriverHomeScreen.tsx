import {
  confirmPickup,
  describeAuthError,
  headToPickup,
  setAvailability,
  type AuthFailure,
  type DriverProfileData,
  type FirebaseClient,
  type VehicleData,
} from '@ridemesh/firebase';
import {
  useAuth,
  useDriverProfile,
  useJourney,
  useJourneyPlanStops,
  useProfile,
  useVehicle,
} from '@ridemesh/firebase/react';
import type { JourneyPlanStop } from '@ridemesh/firebase';
import {
  evaluateGoOnline,
  isEditableJourneyStatus,
  type GoOnlineCheck,
  type GoOnlineRequirement,
} from '@ridemesh/types';
import { fontSize, fontWeight, radius, spacing } from '@ridemesh/ui';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import type { StoredDestination } from '@ridemesh/types';
import type { AuthScreenProps } from '../app-info';
import {
  AuthFrame,
  Heading,
  Notice,
  PrimaryButton,
  SecondaryButton,
  useAuthTheme,
} from '../components';
import { DestinationSection } from './DestinationSection';
import { DetourSection } from './DetourSection';
import { OriginSection } from './OriginSection';
import { SeatsOfferSection } from './SeatsOfferSection';
import { useShareDriverLocation } from './useShareDriverLocation';

const DESCRIPTION = 'Your destination, available seats and matching settings will appear here.';

interface Facts {
  accountActive: boolean;
  driver: DriverProfileData | undefined;
  vehicle: VehicleData | undefined;
  destination: StoredDestination | null;
  origin: StoredDestination | null;
  availableSeats: number | null;
}

/** What each requirement means to the driver: what is done, or what is left to do. */
function describeRequirement(requirement: GoOnlineRequirement, met: boolean, facts: Facts) {
  const driverStatus = facts.driver?.verificationStatus;
  const vehicleStatus = facts.vehicle?.verificationStatus;
  switch (requirement) {
    case 'accountActive':
      return met ? 'Account active' : 'Your account is not active. Please contact support.';
    case 'driverVerified':
      if (met) return 'Driver profile verified';
      if (driverStatus === 'REJECTED') {
        return 'Your driver profile was not approved. See the Profile tab.';
      }
      return 'Your driver profile is waiting to be verified.';
    case 'vehicleAdded':
      return met ? 'Vehicle added' : 'Add your vehicle in the Profile tab.';
    case 'vehicleVerified':
      if (met) return 'Vehicle verified';
      if (vehicleStatus === 'REJECTED') {
        return 'Your vehicle was not approved. See the Profile tab.';
      }
      return 'Your vehicle needs to be verified.';
    case 'seatsSet':
      return met ? 'Passenger seats set' : 'Set your passenger seats in the Profile tab.';
    case 'destinationDeclared':
      return met ? 'Destination set' : 'Set your destination below.';
    case 'originSet':
      return met ? 'Start of journey saved' : 'Save where you are starting below.';
    case 'seatsOffered':
      return met ? 'Seats on offer set' : 'Choose how many seats you offer below.';
    case 'detourSet':
      return met ? 'Maximum detour set' : 'Choose how far you will go out of your way below.';
  }
}

function Checklist({ checks, facts }: { checks: GoOnlineCheck[]; facts: Facts }) {
  const theme = useAuthTheme();
  return (
    <View
      style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}
      accessibilityLabel="Before you can go online"
    >
      <Text style={[styles.cardTitle, { color: theme.textPrimary }]}>Before you can go online</Text>
      {checks.map(({ requirement, met }) => (
        <View key={requirement} style={styles.item}>
          <Text aria-hidden style={[styles.marker, { color: met ? theme.success : theme.danger }]}>
            {met ? '✓' : '✗'}
          </Text>
          <Text style={[styles.itemText, { color: theme.textPrimary }]}>
            {describeRequirement(requirement, met, facts)}
          </Text>
        </View>
      ))}
    </View>
  );
}

const STOP_LABEL: Record<JourneyPlanStop['kind'], string> = {
  pickup: 'Pick up',
  dropoff: 'Drop off',
};

/**
 * The matched journey's stop order (Module 7.1): who to pick up and drop off, and where, in order.
 * A pickup stop still PICKUP_ASSIGNED or DRIVER_ARRIVING (Module 7.2) gets a button to move it on -
 * both driver-initiated, never automatic (user decision). Dropoff stops have no action yet.
 */
function PassengersCard({
  stops,
  client,
}: {
  stops: JourneyPlanStop[];
  client: Pick<FirebaseClient, 'functions'>;
}) {
  const theme = useAuthTheme();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const act = async (tripId: string, action: 'head' | 'confirm') => {
    setFailure(null);
    setBusyId(tripId);
    try {
      await (action === 'head' ? headToPickup(client, tripId) : confirmPickup(client, tripId));
    } catch (error) {
      setFailure(describeAuthError(error).message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <View
      style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}
      accessibilityLabel="Your passengers"
    >
      <Text style={[styles.cardTitle, { color: theme.textPrimary }]}>Your passengers</Text>
      {failure ? <Notice tone="error">{failure}</Notice> : null}
      {stops.map((stop, index) => (
        <View key={`${stop.requestId}-${stop.kind}`} style={styles.item}>
          <Text style={[styles.itemText, { color: theme.textPrimary }]}>
            {index + 1}. {STOP_LABEL[stop.kind]} {stop.passengerName}
            {stop.address ? ` - ${stop.address}` : ''}
          </Text>
          {stop.kind === 'pickup' && stop.status === 'PICKUP_ASSIGNED' ? (
            <SecondaryButton
              label="Head to pickup"
              onPress={() => void act(stop.requestId, 'head')}
              loading={busyId === stop.requestId}
              disabled={busyId !== null}
            />
          ) : null}
          {stop.kind === 'pickup' && stop.status === 'DRIVER_ARRIVING' ? (
            <PrimaryButton
              label="Confirm pickup"
              onPress={() => void act(stop.requestId, 'confirm')}
              loading={busyId === stop.requestId}
              disabled={busyId !== null}
            />
          ) : null}
        </View>
      ))}
    </View>
  );
}

/** The driver's Home: whether they are online, going online or offline, and what is missing. */
export function DriverHomeScreen({
  theme,
  placesApiKey,
}: Pick<AuthScreenProps, 'theme'> & {
  /** The Maps Platform key for place search, when this build has one. */
  placesApiKey?: string | undefined;
}) {
  const { client } = useAuth();
  const profile = useProfile();
  const driver = useDriverProfile();
  const vehicle = useVehicle();
  const currentJourneyId = driver.status === 'ready' ? driver.driver.currentJourneyId : null;
  const journey = useJourney(currentJourneyId);
  const planStops = useJourneyPlanStops(currentJourneyId);
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const [busy, setBusy] = useState(false);

  const states = [profile.status, driver.status, vehicle.status, journey.status];
  const failed = states.includes('error');
  // Show the spinner only for the first load. When the journey changes later (the first destination
  // has just been saved, so there is a new journey to load) the screen must stay where it is.
  const [loadedOnce, setLoadedOnce] = useState(false);
  const stillLoading = states.includes('loading');
  const loading = !loadedOnce && stillLoading;
  useEffect(() => {
    if (!stillLoading && !failed) setLoadedOnce(true);
  }, [stillLoading, failed]);
  const driverData = driver.status === 'ready' ? driver.driver : undefined;
  const vehicleData = vehicle.status === 'ready' ? vehicle.vehicle : undefined;
  const online = driverData?.availabilityStatus === 'ONLINE';
  // Keep showing the last destination while a new journey loads, so it does not flicker away.
  const lastDestination = useRef<StoredDestination | null>(null);
  const destination =
    journey.status === 'ready'
      ? journey.journey.destination
      : journey.status === 'loading'
        ? lastDestination.current
        : null;
  useEffect(() => {
    lastDestination.current = destination;
  }, [destination]);
  const origin = journey.status === 'ready' ? journey.journey.origin : null;
  const availableSeats = journey.status === 'ready' ? journey.journey.availableSeats : null;
  const maxDetourMinutes = journey.status === 'ready' ? journey.journey.maxDetourMinutes : null;
  const maxDetourDistance = journey.status === 'ready' ? journey.journey.maxDetourDistance : null;
  // Seats and detour stay changeable once the driver goes online (Module 5.1); only once the
  // journey is matched to a request (Module 5.5 onwards) do they stop being.
  const editable = journey.status !== 'ready' || isEditableJourneyStatus(journey.journey.status);

  const facts: Facts = {
    accountActive: profile.status === 'ready' && profile.profile.status === 'ACTIVE',
    driver: driverData,
    vehicle: vehicleData,
    destination,
    origin,
    availableSeats,
  };
  const { eligible, checks } = evaluateGoOnline({
    accountActive: facts.accountActive,
    driverStatus: driverData?.verificationStatus ?? null,
    vehicleStatus: vehicleData?.verificationStatus ?? null,
    seatCapacity: vehicleData?.seatCapacity ?? null,
    destinationDeclared: destination !== null,
    originSet: origin !== null,
    availableSeats,
    maxDetourMinutes,
    maxDetourDistance,
  });

  // While the driver is online their position is followed and shared, sparingly. Offline, nothing is.
  const sharing = useShareDriverLocation(online);

  const change = async (status: 'ONLINE' | 'OFFLINE') => {
    setFailure(null);
    setBusy(true);
    try {
      await setAvailability(client, status);
    } catch (error) {
      setFailure(describeAuthError(error));
    } finally {
      setBusy(false);
    }
  };

  const retry = () => {
    profile.retry();
    driver.retry();
    vehicle.retry();
    journey.retry();
  };

  return (
    <AuthFrame theme={theme} insets={false}>
      {loading ? (
        <ActivityIndicator accessibilityLabel="Loading your status" color={theme.accent} />
      ) : failed ? (
        <>
          <Notice tone="error">We could not load your status. Please try again.</Notice>
          <SecondaryButton label="Try again" onPress={retry} />
        </>
      ) : (
        <>
          <Heading title={online ? 'You are online' : 'You are offline'} subtitle={DESCRIPTION} />
          {failure ? <Notice tone="error">{failure.message}</Notice> : null}
          {online && (sharing.status === 'denied' || sharing.status === 'unavailable') ? (
            <Notice tone="error">
              {sharing.status === 'denied'
                ? 'Your location is not being shared because location is turned off for this app. Turn it on in your browser or phone settings.'
                : 'Your location could not be found, so it is not being shared. Check your signal.'}
            </Notice>
          ) : null}
          {online && sharing.status === 'watching' ? (
            <Notice tone="info">Sharing your location while online.</Notice>
          ) : null}
          {online ? (
            <SecondaryButton
              label={busy ? 'Going offline' : 'Go offline'}
              onPress={() => void change('OFFLINE')}
              disabled={busy}
            />
          ) : (
            <>
              <PrimaryButton
                label="Go online"
                onPress={() => void change('ONLINE')}
                loading={busy}
                disabled={!eligible}
              />
              {eligible ? null : <Checklist checks={checks} facts={facts} />}
            </>
          )}
          {planStops.status === 'ready' && planStops.stops.length > 0 ? (
            <PassengersCard stops={planStops.stops} client={client} />
          ) : null}
          <DestinationSection
            placesApiKey={placesApiKey}
            destination={destination}
            vehicleAdded={vehicleData !== undefined}
          />
          <OriginSection hasJourney={destination !== null} origin={origin} editable={editable} />
          <SeatsOfferSection
            seatCapacity={vehicleData?.seatCapacity ?? null}
            hasJourney={destination !== null}
            availableSeats={availableSeats}
            editable={editable}
          />
          <DetourSection
            hasJourney={destination !== null}
            maxDetourMinutes={maxDetourMinutes}
            maxDetourDistance={maxDetourDistance}
            editable={editable}
          />
        </>
      )}
    </AuthFrame>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: radius.lg, padding: spacing[6], gap: spacing[3] },
  cardTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.semibold },
  item: { flexDirection: 'row', gap: spacing[3], alignItems: 'flex-start' },
  marker: { fontSize: fontSize.base, fontWeight: fontWeight.bold, width: spacing[4] },
  itemText: { flex: 1, fontSize: fontSize.base },
});
