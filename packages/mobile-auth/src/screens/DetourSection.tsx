import { describeAuthError, setJourneyDetour, type AuthFailure } from '@ridemesh/firebase';
import { useAuth } from '@ridemesh/firebase/react';
import { DETOUR_DISTANCE_KM_PRESETS, DETOUR_MINUTES_PRESETS } from '@ridemesh/types';
import { fontSize, fontWeight, radius, spacing } from '@ridemesh/ui';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Notice, PrimaryButton, useAuthTheme } from '../components';
import { ChoiceGroup } from './ChoiceGroup';

const MINUTE_CHOICES = DETOUR_MINUTES_PRESETS.map((value) => ({
  value,
  label: `${value} min`,
}));
const KM_CHOICES = DETOUR_DISTANCE_KM_PRESETS.map((value) => ({ value, label: `${value} km` }));

interface Props {
  /** Whether the driver has a journey yet, which starts with the destination. */
  hasJourney: boolean;
  /** Extra minutes on the journey, or null until the driver chooses. */
  maxDetourMinutes: number | null;
  /** Extra kilometres on the journey, or null until the driver chooses. */
  maxDetourDistance: number | null;
  /** The limits can only be changed while the journey is still a draft. */
  editable: boolean;
}

/**
 * How far the driver will go out of their way for passengers: extra minutes and extra kilometres,
 * each picked from a few presets. The driver has to choose both; nothing is filled in for them.
 */
export function DetourSection({
  hasJourney,
  maxDetourMinutes,
  maxDetourDistance,
  editable,
}: Props) {
  const theme = useAuthTheme();
  const { client } = useAuth();
  const [minutes, setMinutes] = useState<number | null>(maxDetourMinutes);
  const [km, setKm] = useState<number | null>(maxDetourDistance);
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  // Follow the stored values, for example right after they have been saved.
  useEffect(() => setMinutes(maxDetourMinutes), [maxDetourMinutes]);
  useEffect(() => setKm(maxDetourDistance), [maxDetourDistance]);

  const card = [styles.card, { backgroundColor: theme.surface, borderColor: theme.border }];
  const caption = [styles.caption, { color: theme.textSecondary }];
  const heading = (
    <Text style={[styles.heading, { color: theme.textPrimary }]}>Maximum detour</Text>
  );

  if (!hasJourney) {
    return (
      <View style={card} accessibilityLabel="Maximum detour">
        {heading}
        <Text style={caption}>
          Set your destination first, then choose how far you will go out of your way.
        </Text>
      </View>
    );
  }

  if (!editable) {
    return (
      <View style={card} accessibilityLabel="Maximum detour">
        {heading}
        <Text style={caption}>
          {maxDetourMinutes === null || maxDetourDistance === null
            ? 'No detour limits are set on this journey.'
            : `Up to ${maxDetourMinutes} min and ${maxDetourDistance} km out of your way on this journey.`}
        </Text>
      </View>
    );
  }

  const unchanged = minutes === maxDetourMinutes && km === maxDetourDistance;

  const choose = <Value extends number>(set: (value: Value) => void) => {
    return (value: Value) => {
      set(value);
      setFailure(null);
      setJustSaved(false);
    };
  };

  const save = async () => {
    if (minutes === null || km === null) return;
    setFailure(null);
    setJustSaved(false);
    setSaving(true);
    try {
      await setJourneyDetour(client, minutes, km);
      setJustSaved(true);
    } catch (error) {
      setFailure(describeAuthError(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={card} accessibilityLabel="Maximum detour">
      {heading}
      <ChoiceGroup
        label="Extra time you accept"
        choices={MINUTE_CHOICES}
        value={minutes}
        onChange={choose(setMinutes)}
        disabled={saving}
      />
      <ChoiceGroup
        label="Extra distance you accept"
        choices={KM_CHOICES}
        value={km}
        onChange={choose(setKm)}
        disabled={saving}
      />
      <Text style={caption}>
        {maxDetourMinutes === null || maxDetourDistance === null
          ? 'Not chosen yet. Choose both.'
          : 'How far out of your way you will go to pick passengers up and drop them off.'}
      </Text>
      {justSaved ? <Notice tone="info">Your detour limits have been saved.</Notice> : null}
      {failure ? <Notice tone="error">{failure.message}</Notice> : null}
      <PrimaryButton
        label={saving ? 'Saving' : failure?.retryable ? 'Try again' : 'Save detour'}
        onPress={() => void save()}
        loading={saving}
        disabled={minutes === null || km === null || unchanged}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: radius.lg, padding: spacing[6], gap: spacing[3] },
  heading: { fontSize: fontSize.lg, fontWeight: fontWeight.semibold },
  caption: { fontSize: fontSize.sm },
});
