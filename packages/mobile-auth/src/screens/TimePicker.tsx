import { groupSlots, localDayKey, timeInHour, timeOnDay } from '@ridemesh/types';
import { fontSize, fontWeight, spacing } from '@ridemesh/ui';
import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useAuthTheme } from '../components';
import { ChipRow } from './ChipRow';
import { formatClock, formatDay, formatHour, formatMinute } from './timeFormat';

/**
 * Chooses a time from the times offered (`slots`, in steps of five minutes): first the day, then the
 * hour, then the minute. Only times that can be chosen are offered, so nothing that is too soon or too
 * far ahead can be picked. Changing the day or the hour keeps the rest of the time where it can. The
 * days, hours and minutes are those of the device's time zone.
 */
export function TimePicker({
  label,
  slots,
  value,
  now,
  onChange,
}: {
  label: string;
  slots: readonly number[];
  /** The time chosen, or null when none has been. */
  value: number | null;
  now: number;
  onChange: (at: number) => void;
}) {
  const theme = useAuthTheme();
  const days = useMemo(() => groupSlots(slots), [slots]);
  const selectedKey = value === null ? null : localDayKey(value);
  const day = days.find((candidate) => candidate.key === selectedKey);
  const hour = day?.hours.find(
    (candidate) => value !== null && candidate.hour === new Date(value).getHours(),
  );

  return (
    <View style={styles.picker}>
      <Text style={[styles.title, { color: theme.textPrimary }]}>{label}</Text>
      <ChipRow
        label={`${label}: day`}
        chips={days.map((candidate) => ({
          key: candidate.key,
          label: formatDay(candidate.first, now),
          selected: candidate.key === selectedKey,
          onPress: () => onChange(timeOnDay(candidate, value)),
        }))}
      />
      {day ? (
        <ChipRow
          label={`${label}: hour`}
          chips={day.hours.map((candidate) => ({
            key: String(candidate.hour),
            label: formatHour(candidate.hour),
            selected: candidate === hour,
            onPress: () => onChange(timeInHour(candidate, value)),
          }))}
        />
      ) : null}
      {hour ? (
        <ChipRow
          label={`${label}: minute`}
          chips={hour.minutes.map((candidate) => ({
            key: String(candidate.minute),
            label: formatMinute(candidate.minute),
            selected: value !== null && candidate.at === value,
            onPress: () => onChange(candidate.at),
          }))}
        />
      ) : null}
      {value !== null ? (
        <Text style={[styles.chosen, { color: theme.textSecondary }]}>
          {formatDay(value, now)}, {formatClock(value)}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  picker: { gap: spacing[2] },
  title: { fontSize: fontSize.base, fontWeight: fontWeight.semibold },
  chosen: { fontSize: fontSize.sm },
});
