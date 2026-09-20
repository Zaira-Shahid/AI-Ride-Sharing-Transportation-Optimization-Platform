import { describeAuthError, setJourneySeats, type AuthFailure } from '@ridemesh/firebase';
import { useAuth } from '@ridemesh/firebase/react';
import { SEAT_CAPACITY_MIN } from '@ridemesh/types';
import { fontSize, fontWeight, radius, spacing } from '@ridemesh/ui';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Notice, PrimaryButton, useAuthTheme } from '../components';
import { ChoiceGroup } from './ChoiceGroup';

interface Props {
  /** The vehicle's passenger seats, or null until the driver has set them in the Profile tab. */
  seatCapacity: number | null;
  /** Whether the driver has a journey yet, which starts with the destination. */
  hasJourney: boolean;
  /** Seats on offer on the journey, or null until the driver chooses. */
  availableSeats: number | null;
  /** Seats can only be changed while the journey is still a draft. */
  editable: boolean;
}

/**
 * How many passenger seats the driver offers on this journey: one up to what the vehicle holds.
 * The driver has to choose; nothing is filled in for them.
 */
export function SeatsOfferSection({ seatCapacity, hasJourney, availableSeats, editable }: Props) {
  const theme = useAuthTheme();
  const { client } = useAuth();
  const [selected, setSelected] = useState<number | null>(availableSeats);
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  // Follow the stored value, for example right after it has been saved.
  useEffect(() => setSelected(availableSeats), [availableSeats]);

  const card = [styles.card, { backgroundColor: theme.surface, borderColor: theme.border }];
  const caption = [styles.caption, { color: theme.textSecondary }];

  const choose = (seats: number) => {
    setSelected(seats);
    setFailure(null);
    setJustSaved(false);
  };

  const save = async () => {
    if (selected === null) return;
    setFailure(null);
    setJustSaved(false);
    setSaving(true);
    try {
      await setJourneySeats(client, selected);
      setJustSaved(true);
    } catch (error) {
      setFailure(describeAuthError(error));
    } finally {
      setSaving(false);
    }
  };

  if (seatCapacity === null || !hasJourney) {
    return (
      <View style={card} accessibilityLabel="Seats on offer">
        <Text style={[styles.heading, { color: theme.textPrimary }]}>Seats on offer</Text>
        <Text style={caption}>
          {seatCapacity === null
            ? 'Set the passenger seats of your vehicle in the Profile tab first.'
            : 'Set your destination first, then choose how many seats you offer.'}
        </Text>
      </View>
    );
  }

  if (!editable) {
    return (
      <View style={card} accessibilityLabel="Seats on offer">
        <Text style={[styles.heading, { color: theme.textPrimary }]}>Seats on offer</Text>
        <Text style={caption}>
          {availableSeats === null
            ? 'No seats are offered on this journey.'
            : `${availableSeats} of ${seatCapacity} seats offered on this journey.`}
        </Text>
      </View>
    );
  }

  const choices = Array.from(
    { length: seatCapacity - SEAT_CAPACITY_MIN + 1 },
    (_unused, index) => ({
      value: SEAT_CAPACITY_MIN + index,
      label: String(SEAT_CAPACITY_MIN + index),
    }),
  );

  return (
    <View style={card} accessibilityLabel="Seats on offer">
      <Text style={[styles.heading, { color: theme.textPrimary }]}>Seats on offer</Text>
      <ChoiceGroup
        label="Seats you offer"
        choices={choices}
        value={selected}
        onChange={choose}
        disabled={saving}
      />
      <Text style={caption}>
        {availableSeats === null
          ? `Not chosen yet. Your vehicle has ${seatCapacity} passenger seats.`
          : `Your vehicle has ${seatCapacity} passenger seats.`}
      </Text>
      {justSaved ? <Notice tone="info">Your seats have been saved.</Notice> : null}
      {failure ? <Notice tone="error">{failure.message}</Notice> : null}
      <PrimaryButton
        label={saving ? 'Saving' : failure?.retryable ? 'Try again' : 'Save seats'}
        onPress={() => void save()}
        loading={saving}
        disabled={selected === null || selected === availableSeats}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: radius.lg, padding: spacing[6], gap: spacing[3] },
  heading: { fontSize: fontSize.lg, fontWeight: fontWeight.semibold },
  caption: { fontSize: fontSize.sm },
});
