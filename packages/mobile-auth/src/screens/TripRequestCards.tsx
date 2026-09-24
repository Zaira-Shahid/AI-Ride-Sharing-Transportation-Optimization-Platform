import {
  ESTIMATE_CAVEAT,
  describeEstimate,
  type FlexibilityLevel,
  type TripEstimate,
  type TripRequestStatus,
} from '@ridemesh/types';
import type { MatchedDriverInfo } from '@ridemesh/firebase';
import { fontSize, fontWeight, radius, spacing } from '@ridemesh/ui';
import { StyleSheet, Text, View } from 'react-native';
import { Notice, PrimaryButton, SecondaryButton, useAuthTheme } from '../components';
import { formatWhen } from './timeFormat';
import { TRIP_STATUS_TEXT } from './tripStatusText';

const VEHICLE_TYPE_NAMES: Record<string, string> = {
  CAR: 'Car',
  VAN: 'Van',
  MINIBUS: 'Minibus',
};

/** The matched driver's name and vehicle, once assigned. Shown from PICKUP_ASSIGNED onwards. */
function DriverInfoCard({ driver }: { driver: MatchedDriverInfo }) {
  const theme = useAuthTheme();
  const vehicle = [
    driver.vehicleType ? VEHICLE_TYPE_NAMES[driver.vehicleType] ?? driver.vehicleType : null,
    driver.vehicleMake,
    driver.vehicleModel,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <View style={styles.line} accessibilityLabel="Your driver">
      <Text style={[styles.caption, { color: theme.textSecondary }]}>Your driver</Text>
      <Text style={[styles.value, { color: theme.textPrimary }]}>{driver.name}</Text>
      {vehicle ? (
        <Text style={[styles.caption, { color: theme.textSecondary }]}>
          {vehicle}
          {driver.vehiclePlateNumber ? ` · ${driver.vehiclePlateNumber}` : ''}
        </Text>
      ) : null}
    </View>
  );
}

const LEVEL_NAMES: Record<FlexibilityLevel, string> = {
  STRICT: 'Strict',
  BALANCED: 'Balanced',
  FLEXIBLE: 'Flexible',
};

/** What a ride request says, in words. The same lines are shown before it is sent and once it is. */
export interface TripSummaryData {
  pickup: string;
  destination: string;
  /** When to leave, in ms since 1970, or null for now. */
  departureAt: number | null;
  /** The time to arrive by, in ms since 1970, or null for no deadline. */
  arriveBy: number | null;
  level: FlexibilityLevel | null;
  allowSharedRide: boolean;
}

function SummaryLine({ caption, value }: { caption: string; value: string }) {
  const theme = useAuthTheme();
  return (
    <View style={styles.line}>
      <Text style={[styles.caption, { color: theme.textSecondary }]}>{caption}</Text>
      <Text style={[styles.value, { color: theme.textPrimary }]}>{value}</Text>
    </View>
  );
}

function TripSummary({ summary, now }: { summary: TripSummaryData; now: number }) {
  return (
    <View style={styles.summary}>
      <SummaryLine caption="Pickup" value={summary.pickup} />
      <SummaryLine caption="Destination" value={summary.destination} />
      <SummaryLine
        caption="Leaving"
        value={summary.departureAt === null ? 'Now' : formatWhen(summary.departureAt, now)}
      />
      {summary.arriveBy === null ? null : (
        <SummaryLine caption="Arrive by" value={formatWhen(summary.arriveBy, now)} />
      )}
      {summary.level === null ? null : (
        <SummaryLine
          caption="Flexibility"
          value={`${LEVEL_NAMES[summary.level]}, ${summary.allowSharedRide ? 'sharing the ride' : 'not sharing'}`}
        />
      )}
    </View>
  );
}

/** Where the estimate of a trip stands, for the card that shows it. */
export type EstimateView =
  { state: 'loading' } | { state: 'ready'; estimate: TripEstimate } | { state: 'unavailable' };

/**
 * The estimated time and distance of the trip (Modules 4.4 and 4.5), or a line saying it is being
 * worked out or could not be. It always says the estimate has no live traffic, and it is only ever a
 * note: nothing about the request depends on it.
 */
function EstimateNote({ view }: { view: EstimateView }) {
  const theme = useAuthTheme();
  return (
    <View style={styles.line} accessibilityLabel="Estimated trip">
      {view.state === 'ready' ? (
        <>
          <Text style={[styles.caption, { color: theme.textSecondary }]}>Estimated trip</Text>
          <Text style={[styles.value, { color: theme.textPrimary }]}>
            {describeEstimate(view.estimate)}
          </Text>
          <Text style={[styles.caption, { color: theme.textSecondary }]}>{ESTIMATE_CAVEAT}</Text>
        </>
      ) : (
        <Text style={[styles.caption, { color: theme.textSecondary }]}>
          {view.state === 'loading'
            ? 'Estimating the trip time.'
            : 'We could not estimate the trip time. You can still request the ride.'}
        </Text>
      )}
    </View>
  );
}

function useCardStyle() {
  const theme = useAuthTheme();
  return [styles.card, { backgroundColor: theme.surface, borderColor: theme.border }];
}

/** The last look before a request is sent: what it says, with a button to send it and one to go back. */
export function ReviewCard({
  summary,
  now,
  estimate,
  arrivalWarning,
  sending,
  problem,
  onConfirm,
  onBack,
}: {
  summary: TripSummaryData;
  now: number;
  /** The estimated time and distance of the trip, as far as it is known. */
  estimate: EstimateView;
  /** Said when the arrival time leaves less than the estimated trip; a warning, never a refusal. */
  arrivalWarning: string | null;
  sending: boolean;
  /** Why the request was not accepted, if it was not. */
  problem: string | null;
  onConfirm: () => void;
  onBack: () => void;
}) {
  const theme = useAuthTheme();
  return (
    <View style={useCardStyle()} accessibilityLabel="Review your ride request">
      <Text accessibilityRole="header" style={[styles.title, { color: theme.textPrimary }]}>
        Review your ride request
      </Text>
      <TripSummary summary={summary} now={now} />
      <EstimateNote view={estimate} />
      {arrivalWarning ? <Notice tone="info">{arrivalWarning}</Notice> : null}
      {problem ? <Notice tone="error">{problem}</Notice> : null}
      <PrimaryButton label="Confirm ride request" onPress={onConfirm} loading={sending} />
      <SecondaryButton label="Back" onPress={onBack} disabled={sending} />
    </View>
  );
}

/**
 * A request that has been made: where it stands (the status, in words), what it says, and a button
 * to cancel it while that is possible. The card keeps the name "Ride requested" whatever the status.
 */
export function RequestedCard({
  status,
  summary,
  now,
  estimate,
  driver,
  cancellable,
  problem,
  onCancel,
}: {
  status: TripRequestStatus;
  summary: TripSummaryData;
  now: number;
  /** The estimated time and distance of the trip, as far as it is known. */
  estimate: EstimateView;
  /** The matched driver and vehicle (Module 7.3), or null before a driver is assigned. */
  driver: MatchedDriverInfo | null;
  /** Whether the passenger may cancel from this status (canPassengerCancel). */
  cancellable: boolean;
  problem: string | null;
  onCancel: () => void;
}) {
  const theme = useAuthTheme();
  return (
    <View style={useCardStyle()} accessibilityLabel="Ride requested">
      <Text accessibilityRole="header" style={[styles.title, { color: theme.textPrimary }]}>
        {TRIP_STATUS_TEXT[status].title}
      </Text>
      <Text style={[styles.caption, { color: theme.textSecondary }]}>
        {TRIP_STATUS_TEXT[status].detail}
      </Text>
      {driver ? <DriverInfoCard driver={driver} /> : null}
      <TripSummary summary={summary} now={now} />
      <EstimateNote view={estimate} />
      {problem ? <Notice tone="error">{problem}</Notice> : null}
      {cancellable ? <SecondaryButton label="Cancel ride request" onPress={onCancel} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: radius.lg, padding: spacing[4], gap: spacing[3] },
  title: { fontSize: fontSize.base, fontWeight: fontWeight.semibold },
  summary: { gap: spacing[2] },
  line: { gap: 2 },
  caption: { fontSize: fontSize.sm },
  value: { fontSize: fontSize.base, fontWeight: fontWeight.medium },
});
