import {
  MAX_AHEAD_DAYS,
  MIN_LEAD_MINUTES,
  arrivalSlots,
  checkTripTimes,
  departureSlots,
  type TripTimes,
  type TripTimesProblem,
} from '@ridemesh/types';
import { fontSize, fontWeight, radius, spacing } from '@ridemesh/ui';
import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { CompactButton, Notice, SecondaryButton, useAuthTheme } from '../components';
import { ChoiceGroup } from './ChoiceGroup';
import { TimePicker } from './TimePicker';
import { deviceTimeZone, formatWhen } from './timeFormat';

const DEPARTURE_CHOICES = [
  { value: 'NOW', label: 'Leave now' },
  { value: 'AT', label: 'Pick a time' },
] as const;

const ARRIVAL_CHOICES = [
  { value: 'NONE', label: 'No arrival time' },
  { value: 'SET', label: 'Arrive by a time' },
] as const;

/** What to tell the person about a time that cannot be used. */
function describeProblem({ field, problem }: TripTimesProblem): string {
  const what = field === 'departure' ? 'leaving' : 'arrival';
  switch (problem) {
    case 'TOO_SOON':
      return field === 'departure'
        ? `That leaving time is less than ${MIN_LEAD_MINUTES} minutes away. Choose a later time, or leave now.`
        : `That ${what} time is less than ${MIN_LEAD_MINUTES} minutes away. Choose a later time.`;
    case 'TOO_FAR':
      return `You can plan a trip up to ${MAX_AHEAD_DAYS} days ahead. Choose an earlier ${what} time.`;
    case 'NOT_AFTER_DEPARTURE':
      return 'Your arrival time must be after your departure time. Choose a later arrival time.';
    default:
      return `That ${what} time is not valid. Please choose another.`;
  }
}

/**
 * When the passenger wants to go: leave now (the default) or at a time chosen, and, if they like, a
 * time to arrive by. Both are optional. Times can be chosen from 5 minutes to 7 days ahead, in steps
 * of 5 minutes, shown in the device's time zone; they are held as instants (UTC) and only in the app
 * until the request is created (Module 3.7).
 */
export function TripTimeCard({
  times,
  now,
  onChange,
}: {
  times: TripTimes;
  now: number;
  onChange: (times: TripTimes) => void;
}) {
  const theme = useAuthTheme();
  const leaveSlots = useMemo(() => departureSlots(now), [now]);
  const arriveSlots = useMemo(() => arrivalSlots(now, times.departure), [now, times.departure]);
  const problem = checkTripTimes(times, now);
  const leaving = times.departure.kind;
  // Shown as a short summary until the passenger wants to change it, so that the card does not cover
  // the map while nothing is being changed.
  const [editing, setEditing] = useState(false);

  const chooseDeparture = (kind: 'NOW' | 'AT') => {
    if (kind === 'NOW') return onChange({ ...times, departure: { kind: 'NOW' } });
    const first = leaveSlots[0];
    if (first !== undefined) onChange({ ...times, departure: { kind: 'AT', at: first } });
  };

  const chooseArrival = (kind: 'NONE' | 'SET') => {
    if (kind === 'NONE') return onChange({ ...times, arriveBy: null });
    const first = arriveSlots[0];
    if (first !== undefined) onChange({ ...times, arriveBy: first });
  };

  const cardStyle = [styles.card, { backgroundColor: theme.surface, borderColor: theme.border }];

  if (!editing) {
    return (
      <View style={cardStyle} accessibilityLabel="When">
        <Text accessibilityRole="header" style={[styles.title, { color: theme.textPrimary }]}>
          When do you want to go?
        </Text>
        <View style={styles.summaryRow}>
          <View style={styles.summary}>
            <Text style={[styles.summaryLine, { color: theme.textPrimary }]}>
              {times.departure.kind === 'NOW'
                ? 'Leaving now'
                : `Leaving ${formatWhen(times.departure.at, now)}`}
            </Text>
            <Text style={[styles.summaryLine, { color: theme.textPrimary }]}>
              {times.arriveBy === null
                ? 'No arrival time'
                : `Arrive by ${formatWhen(times.arriveBy, now)}`}
            </Text>
          </View>
          <CompactButton
            label="Change times"
            visibleLabel="Change"
            onPress={() => setEditing(true)}
          />
        </View>
        {problem ? <Notice tone="error">{describeProblem(problem)}</Notice> : null}
      </View>
    );
  }

  return (
    <View style={cardStyle} accessibilityLabel="When">
      <Text accessibilityRole="header" style={[styles.title, { color: theme.textPrimary }]}>
        When do you want to go?
      </Text>

      <ChoiceGroup
        label="Leaving"
        choices={DEPARTURE_CHOICES}
        value={leaving}
        onChange={chooseDeparture}
        disabled={false}
      />
      {times.departure.kind === 'AT' ? (
        <TimePicker
          label="Leave at"
          slots={leaveSlots}
          value={times.departure.at}
          now={now}
          onChange={(at) => onChange({ ...times, departure: { kind: 'AT', at } })}
        />
      ) : null}
      {problem?.field === 'departure' ? (
        <Notice tone="error">{describeProblem(problem)}</Notice>
      ) : null}

      <ChoiceGroup
        label="Arriving"
        choices={ARRIVAL_CHOICES}
        value={times.arriveBy === null ? 'NONE' : 'SET'}
        onChange={chooseArrival}
        disabled={false}
      />
      {times.arriveBy === null && arriveSlots.length === 0 ? (
        <Text style={[styles.caption, { color: theme.textSecondary }]}>
          There is no time left to arrive by. Choose an earlier departure.
        </Text>
      ) : null}
      {times.arriveBy !== null ? (
        <TimePicker
          label="Arrive by"
          slots={arriveSlots}
          value={times.arriveBy}
          now={now}
          onChange={(at) => onChange({ ...times, arriveBy: at })}
        />
      ) : null}
      {problem?.field === 'arriveBy' ? (
        <Notice tone="error">{describeProblem(problem)}</Notice>
      ) : null}

      <Text style={[styles.caption, { color: theme.textSecondary }]}>
        Times are in your time zone ({deviceTimeZone()}).
      </Text>
      <SecondaryButton label="Done" onPress={() => setEditing(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: radius.lg, padding: spacing[4], gap: spacing[3] },
  title: { fontSize: fontSize.base, fontWeight: fontWeight.semibold },
  caption: { fontSize: fontSize.sm },
  summaryRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  summary: { flex: 1, gap: spacing[1] },
  summaryLine: { fontSize: fontSize.base, fontWeight: fontWeight.medium },
});
