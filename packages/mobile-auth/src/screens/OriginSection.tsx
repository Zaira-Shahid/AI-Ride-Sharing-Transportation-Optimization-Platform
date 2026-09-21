import {
  describeAuthError,
  reverseGeocode,
  setJourneyOrigin,
  type AuthFailure,
} from '@ridemesh/firebase';
import { useAuth } from '@ridemesh/firebase/react';
import { useCurrentLocation } from '@ridemesh/map';
import type { StoredDestination } from '@ridemesh/types';
import { fontSize, fontWeight, radius, spacing } from '@ridemesh/ui';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Notice, SecondaryButton, useAuthTheme } from '../components';

interface Props {
  /** Whether the driver has a journey yet, which starts with the destination. */
  hasJourney: boolean;
  /** Where the journey starts, or null until the driver saves it. */
  origin: StoredDestination | null;
  /** The start can only be changed while the journey is still a draft. */
  editable: boolean;
}

const LOCATION_PROBLEMS = {
  denied:
    'Location is turned off for this app. You can turn it on in your browser or phone settings.',
  unavailable: 'We could not find your location. Check your signal and try again.',
} as const;

/**
 * Where the driver's journey starts. The driver taps a button and the device's position is read
 * once (never before, and nothing is watched here) and saved on the journey with the address the
 * server finds for it (reverse geocoding, Module 4.2, on a position rounded to about 11 m), or
 * "Current location" when no address can be found. It is needed before going online.
 */
export function OriginSection({ hasJourney, origin, editable }: Props) {
  const theme = useAuthTheme();
  const { client } = useAuth();
  // The start is saved, so it is read afresh: never a position a minute old.
  const location = useCurrentLocation({ maxAgeMs: 0 });
  const [asking, setAsking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [failure, setFailure] = useState<AuthFailure | null>(null);

  // When the device's position arrives for a start the driver asked for, that is what is saved.
  const { status, point } = location;
  useEffect(() => {
    if (!asking) return;
    if (status === 'denied' || status === 'unavailable') {
      setAsking(false);
      return;
    }
    if (status !== 'ready' || !point) return;
    setAsking(false);
    setSaving(true);
    // The address is a nicety: when it cannot be found the start is saved as "Current location".
    void reverseGeocode(client, point)
      .then((address) => setJourneyOrigin(client, point, address))
      .then(() => setJustSaved(true))
      .catch((error: unknown) => setFailure(describeAuthError(error)))
      .finally(() => setSaving(false));
  }, [asking, status, point, client]);

  const card = [styles.card, { backgroundColor: theme.surface, borderColor: theme.border }];
  const caption = [styles.caption, { color: theme.textSecondary }];

  const start = () => {
    setFailure(null);
    setJustSaved(false);
    setAsking(true);
    location.locate();
  };

  const problem =
    location.status === 'denied' || location.status === 'unavailable'
      ? LOCATION_PROBLEMS[location.status]
      : null;

  return (
    <View style={card} accessibilityLabel="Start of journey">
      <Text style={[styles.heading, { color: theme.textPrimary }]}>Start of your journey</Text>

      {origin ? (
        <View style={styles.current}>
          <Text style={caption}>Starting from</Text>
          <Text style={[styles.address, { color: theme.textPrimary }]}>
            {origin.formattedAddress}
          </Text>
        </View>
      ) : null}

      {!hasJourney ? (
        <Text style={caption}>Set your destination first, then save where you are starting.</Text>
      ) : !editable ? (
        origin === null ? (
          <Text style={caption}>No start was saved for this journey.</Text>
        ) : null
      ) : (
        <>
          <Text style={caption}>
            {origin === null
              ? 'Not saved yet. We read your position once, when you press the button.'
              : 'Saved from your device’s position. Press the button to save where you are now.'}
          </Text>
          {justSaved ? <Notice tone="info">Your start has been saved.</Notice> : null}
          {problem ? <Notice tone="error">{problem}</Notice> : null}
          {failure ? <Notice tone="error">{failure.message}</Notice> : null}
          <SecondaryButton
            label={
              saving || asking
                ? 'Saving your start'
                : origin === null
                  ? 'Use my current location as the start'
                  : 'Update my start'
            }
            onPress={start}
            disabled={saving || asking}
          />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: radius.lg, padding: spacing[6], gap: spacing[3] },
  heading: { fontSize: fontSize.lg, fontWeight: fontWeight.semibold },
  caption: { fontSize: fontSize.sm },
  current: { gap: spacing[1] },
  address: { fontSize: fontSize.base, fontWeight: fontWeight.medium },
});
