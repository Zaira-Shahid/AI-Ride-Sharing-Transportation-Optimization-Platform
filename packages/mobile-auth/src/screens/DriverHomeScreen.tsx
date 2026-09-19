import {
  describeAuthError,
  setAvailability,
  type AuthFailure,
  type DriverProfileData,
  type VehicleData,
} from '@ridemesh/firebase';
import { useAuth, useDriverProfile, useProfile, useVehicle } from '@ridemesh/firebase/react';
import { evaluateGoOnline, type GoOnlineCheck, type GoOnlineRequirement } from '@ridemesh/types';
import { fontSize, fontWeight, radius, spacing } from '@ridemesh/ui';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import type { AuthScreenProps } from '../app-info';
import {
  AuthFrame,
  Heading,
  Notice,
  PrimaryButton,
  SecondaryButton,
  useAuthTheme,
} from '../components';

const DESCRIPTION = 'Your destination, available seats and matching settings will appear here.';

interface Facts {
  accountActive: boolean;
  driver: DriverProfileData | undefined;
  vehicle: VehicleData | undefined;
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
export function DriverHomeScreen({ theme }: Pick<AuthScreenProps, 'theme'>) {
  const { client } = useAuth();
  const profile = useProfile();
  const driver = useDriverProfile();
  const vehicle = useVehicle();
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const [busy, setBusy] = useState(false);

  const states = [profile.status, driver.status, vehicle.status];
  const loading = states.includes('loading');
  const failed = states.includes('error');
  const driverData = driver.status === 'ready' ? driver.driver : undefined;
  const vehicleData = vehicle.status === 'ready' ? vehicle.vehicle : undefined;
  const online = driverData?.availabilityStatus === 'ONLINE';

  const facts: Facts = {
    accountActive: profile.status === 'ready' && profile.profile.status === 'ACTIVE',
    driver: driverData,
    vehicle: vehicleData,
  };
  const { eligible, checks } = evaluateGoOnline({
    accountActive: facts.accountActive,
    driverStatus: driverData?.verificationStatus ?? null,
    vehicleStatus: vehicleData?.verificationStatus ?? null,
    seatCapacity: vehicleData?.seatCapacity ?? null,
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
