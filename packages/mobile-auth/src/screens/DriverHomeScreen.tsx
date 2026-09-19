import {
  describeAuthError,
  setAvailability,
  type AuthFailure,
  type DriverProfileData,
  type VehicleData,
} from '@ridemesh/firebase';
import {
  useAuth,
  useDriverProfile,
  useJourney,
  useProfile,
  useVehicle,
} from '@ridemesh/firebase/react';
import { evaluateGoOnline, type GoOnlineCheck, type GoOnlineRequirement } from '@ridemesh/types';
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

const DESCRIPTION = 'Your destination, available seats and matching settings will appear here.';

interface Facts {
  accountActive: boolean;
  driver: DriverProfileData | undefined;
  vehicle: VehicleData | undefined;
  destination: StoredDestination | null;
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

  const facts: Facts = {
    accountActive: profile.status === 'ready' && profile.profile.status === 'ACTIVE',
    driver: driverData,
    vehicle: vehicleData,
    destination,
  };
  const { eligible, checks } = evaluateGoOnline({
    accountActive: facts.accountActive,
    driverStatus: driverData?.verificationStatus ?? null,
    vehicleStatus: vehicleData?.verificationStatus ?? null,
    seatCapacity: vehicleData?.seatCapacity ?? null,
    destinationDeclared: destination !== null,
  });

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
          <DestinationSection
            placesApiKey={placesApiKey}
            destination={destination}
            vehicleAdded={vehicleData !== undefined}
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
