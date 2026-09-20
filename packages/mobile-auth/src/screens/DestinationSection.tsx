import { declareDestination } from '@ridemesh/firebase';
import { useAuth } from '@ridemesh/firebase/react';
import type { StoredDestination } from '@ridemesh/types';
import { fontSize, fontWeight, radius, spacing } from '@ridemesh/ui';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Notice, SecondaryButton, TextButton, useAuthTheme } from '../components';
import { PlaceSearch } from './PlaceSearch';

interface Props {
  /** The Maps Platform key for this build, if one was configured. */
  placesApiKey: string | undefined;
  /** The destination of the driver's journey, or null when none is set. */
  destination: StoredDestination | null;
  /** A destination needs a vehicle, so this is false until one has been added. */
  vehicleAdded: boolean;
}

/**
 * Where the driver is heading: shows it, or searches for one with Google Places autocomplete and
 * saves the place picked. Picking a suggestion saves it straight away, so nothing more has to be
 * typed. The coordinates come from Google, not from the driver.
 */
export function DestinationSection({ placesApiKey, destination, vehicleAdded }: Props) {
  const theme = useAuthTheme();
  const { client } = useAuth();

  const [changing, setChanging] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  const save = async (place: StoredDestination) => {
    setJustSaved(false);
    await declareDestination(client, place);
    setJustSaved(true);
    setChanging(false);
  };

  const startChanging = () => {
    setJustSaved(false);
    setChanging(true);
  };

  const searching = changing || destination === null;
  const card = [styles.card, { backgroundColor: theme.surface, borderColor: theme.border }];

  return (
    <View style={card} accessibilityLabel="Destination">
      <Text style={[styles.heading, { color: theme.textPrimary }]}>Destination</Text>

      {destination ? (
        <View style={styles.current}>
          <Text style={[styles.caption, { color: theme.textSecondary }]}>Heading to</Text>
          <Text style={[styles.address, { color: theme.textPrimary }]}>
            {destination.formattedAddress}
          </Text>
        </View>
      ) : null}
      {justSaved ? <Notice tone="info">Your destination has been saved.</Notice> : null}

      {!vehicleAdded ? (
        <Text style={[styles.caption, { color: theme.textSecondary }]}>
          Add your vehicle in the Profile tab before you set a destination.
        </Text>
      ) : searching || !placesApiKey ? (
        // Without a key the search shows why it cannot be used, and there is nothing to change.
        <>
          <PlaceSearch
            placesApiKey={placesApiKey}
            label="Search for a destination"
            onPick={save}
            busyLabel="Saving your destination"
          />
          {destination && placesApiKey ? (
            <TextButton label="Cancel" onPress={() => setChanging(false)} />
          ) : null}
        </>
      ) : (
        <SecondaryButton label="Change destination" onPress={startChanging} />
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
