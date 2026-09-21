import { useMyTripRequests } from '@ridemesh/firebase/react';
import type { TripRequestData } from '@ridemesh/firebase';
import { describeEstimate, isOpenTripStatus } from '@ridemesh/types';
import { fontSize, fontWeight, radius, spacing } from '@ridemesh/ui';
import { StyleSheet, Text, View } from 'react-native';
import type { AuthScreenProps } from '../app-info';
import { AuthFrame, Heading, Notice, TextButton, useAuthTheme } from '../components';
import { TRIP_STATUS_TEXT } from './tripStatusText';
import { formatWhen } from './timeFormat';
import { useNow } from './useNow';

// How often the list looks at the clock again, for the times it writes as "Today" and "Tomorrow".
const NOW_REFRESH_MS = 60_000;

function TripRow({ trip, now }: { trip: TripRequestData; now: number }) {
  const theme = useAuthTheme();
  const when = trip.departureAt ?? trip.requestedAt;
  return (
    <View
      accessibilityLabel={`Trip: ${TRIP_STATUS_TEXT[trip.status].label}`}
      style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}
    >
      <Text style={[styles.status, { color: theme.textPrimary }]}>
        {TRIP_STATUS_TEXT[trip.status].label}
      </Text>
      <Text style={[styles.line, { color: theme.textPrimary }]}>
        From {trip.origin.formattedAddress}
      </Text>
      <Text style={[styles.line, { color: theme.textPrimary }]}>
        To {trip.destination.formattedAddress}
      </Text>
      {when === null ? null : (
        <Text style={[styles.caption, { color: theme.textSecondary }]}>
          {formatWhen(when, now)}
        </Text>
      )}
      {trip.estimate ? (
        <Text style={[styles.caption, { color: theme.textSecondary }]}>
          Estimated {describeEstimate(trip.estimate)}
        </Text>
      ) : null}
      {trip.arriveBy === null ? null : (
        <Text style={[styles.caption, { color: theme.textSecondary }]}>
          Arrive by {formatWhen(trip.arriveBy, now)}
        </Text>
      )}
    </View>
  );
}

function Group({ title, trips, now }: { title: string; trips: TripRequestData[]; now: number }) {
  const theme = useAuthTheme();
  if (trips.length === 0) return null;
  return (
    <View style={styles.group} accessibilityLabel={title}>
      <Text accessibilityRole="header" style={[styles.groupTitle, { color: theme.textPrimary }]}>
        {title}
      </Text>
      {trips.map((trip) => (
        <TripRow key={trip.id} trip={trip} now={now} />
      ))}
    </View>
  );
}

function Empty() {
  const theme = useAuthTheme();
  return (
    <View
      style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}
      accessibilityLabel="No trips"
    >
      <Text style={[styles.status, { color: theme.textPrimary }]}>No trips yet</Text>
      <Text style={[styles.caption, { color: theme.textSecondary }]}>
        Your past and upcoming trips will appear here.
      </Text>
    </View>
  );
}

/**
 * The passenger's Trips tab: their trip requests, the ones still going first ("Upcoming", newest
 * first) and then the ones that have ended ("Past"). It reads the passenger's own requests only, live,
 * so a change the server makes shows up without reloading. Cancelling is done from Home, where the
 * open request is shown. Only the most recent requests are followed (TRIP_LIST_LIMIT).
 */
export function TripsScreen({ theme }: Pick<AuthScreenProps, 'theme'>) {
  const trips = useMyTripRequests();
  const now = useNow(NOW_REFRESH_MS);

  const upcoming =
    trips.status === 'ready' ? trips.trips.filter((t) => isOpenTripStatus(t.status)) : [];
  const past =
    trips.status === 'ready' ? trips.trips.filter((t) => !isOpenTripStatus(t.status)) : [];

  return (
    <AuthFrame theme={theme} insets={false}>
      <Heading title="Your trips" />
      {trips.status === 'loading' ? (
        <Notice tone="info">Loading your trips.</Notice>
      ) : trips.status === 'error' ? (
        <View style={styles.group}>
          <Notice tone="error">We could not load your trips.</Notice>
          <TextButton label="Try again" onPress={trips.retry} />
        </View>
      ) : trips.trips.length === 0 ? (
        <Empty />
      ) : (
        <View style={styles.groups}>
          <Group title="Upcoming" trips={upcoming} now={now} />
          <Group title="Past" trips={past} now={now} />
        </View>
      )}
    </AuthFrame>
  );
}

const styles = StyleSheet.create({
  groups: { gap: spacing[6] },
  group: { gap: spacing[3] },
  groupTitle: { fontSize: fontSize.base, fontWeight: fontWeight.semibold },
  card: { borderWidth: 1, borderRadius: radius.lg, padding: spacing[4], gap: spacing[1] },
  status: { fontSize: fontSize.base, fontWeight: fontWeight.semibold },
  line: { fontSize: fontSize.base },
  caption: { fontSize: fontSize.sm },
});
