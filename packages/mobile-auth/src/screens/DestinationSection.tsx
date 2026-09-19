import { declareDestination, describeAuthError, type AuthFailure } from '@ridemesh/firebase';
import { useAuth } from '@ridemesh/firebase/react';
import {
  PLACE_SEARCH_MIN_LENGTH,
  PlacesError,
  createSessionToken,
  getPlaceDestination,
  searchPlaces,
  type PlaceSuggestion,
} from '@ridemesh/maps';
import type { StoredDestination } from '@ridemesh/types';
import { fontSize, fontWeight, radius, spacing } from '@ridemesh/ui';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Notice, SecondaryButton, TextButton, TextField, useAuthTheme } from '../components';

const SEARCH_DELAY_MS = 300;

/** What a person is told when the place search fails. Never the raw error. */
function placesMessage(error: unknown): string {
  const kind = error instanceof PlacesError ? error.kind : 'unexpected';
  switch (kind) {
    case 'not-configured':
      return 'Place search is not set up in this version of the app.';
    case 'network':
      return 'We could not search places. Check your connection and try again.';
    case 'rejected':
      return 'Place search is not available right now. Please try again later.';
    case 'not-found':
      return 'That place could not be found. Try another one.';
    default:
      return 'Place search gave an unexpected answer. Please try again.';
  }
}

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
  const places = useMemo(() => ({ apiKey: placesApiKey }), [placesApiKey]);

  const [changing, setChanging] = useState(false);
  const [query, setQuery] = useState('');
  const [session, setSession] = useState(createSessionToken);
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [searched, setSearched] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [saveFailure, setSaveFailure] = useState<AuthFailure | string | null>(null);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  // Search for places a moment after the person stops typing, and drop answers that arrive late.
  useEffect(() => {
    const text = query.trim();
    setSearched(false);
    if (!placesApiKey || text.length < PLACE_SEARCH_MIN_LENGTH) {
      setSuggestions([]);
      setSearchError(null);
      return undefined;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchPlaces(places, text, session, controller.signal)
        .then((found) => {
          setSuggestions(found);
          setSearchError(null);
          setSearched(true);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setSuggestions([]);
          setSearchError(placesMessage(error));
        });
    }, SEARCH_DELAY_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, session, places, placesApiKey]);

  const pick = async (suggestion: PlaceSuggestion) => {
    setSaveFailure(null);
    setJustSaved(false);
    setSaving(true);
    try {
      const place = await getPlaceDestination(places, suggestion.placeId, session);
      await declareDestination(client, place);
      setJustSaved(true);
      setChanging(false);
      setQuery('');
      setSuggestions([]);
      // A saved place ends the search session; the next search starts a new one.
      setSession(createSessionToken());
    } catch (error) {
      setSaveFailure(
        error instanceof PlacesError ? placesMessage(error) : describeAuthError(error),
      );
    } finally {
      setSaving(false);
    }
  };

  const startChanging = () => {
    setJustSaved(false);
    setSaveFailure(null);
    setChanging(true);
  };

  const cancel = () => {
    setChanging(false);
    setQuery('');
    setSuggestions([]);
    setSaveFailure(null);
  };

  const searching = changing || destination === null;
  const failureMessage = typeof saveFailure === 'string' ? saveFailure : saveFailure?.message;
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
      {failureMessage ? <Notice tone="error">{failureMessage}</Notice> : null}

      {!vehicleAdded ? (
        <Text style={[styles.caption, { color: theme.textSecondary }]}>
          Add your vehicle in the Profile tab before you set a destination.
        </Text>
      ) : !placesApiKey ? (
        <Notice tone="error">{placesMessage(new PlacesError('not-configured', ''))}</Notice>
      ) : searching ? (
        <>
          <TextField
            label="Search for a destination"
            value={query}
            onChangeText={setQuery}
            autoCapitalize="words"
            returnKeyType="search"
            editable={!saving}
          />
          {searchError ? <Notice tone="error">{searchError}</Notice> : null}
          {saving ? (
            <ActivityIndicator accessibilityLabel="Saving your destination" color={theme.accent} />
          ) : null}
          {suggestions.length > 0 ? (
            <View role="list" style={styles.results}>
              {suggestions.map((suggestion) => (
                <Pressable
                  key={suggestion.placeId}
                  role="button"
                  aria-label={suggestion.text}
                  aria-disabled={saving}
                  disabled={saving}
                  onPress={() => void pick(suggestion)}
                  style={[styles.result, { borderColor: theme.border }]}
                >
                  <Text style={[styles.primary, { color: theme.textPrimary }]}>
                    {suggestion.primary}
                  </Text>
                  {suggestion.secondary ? (
                    <Text style={[styles.caption, { color: theme.textSecondary }]}>
                      {suggestion.secondary}
                    </Text>
                  ) : null}
                </Pressable>
              ))}
              {/* Google requires its attribution next to place suggestions shown without a map. */}
              <Text style={[styles.caption, { color: theme.textSecondary }]}>
                Powered by Google
              </Text>
            </View>
          ) : searched && !searchError ? (
            <Text style={[styles.caption, { color: theme.textSecondary }]}>
              No places found. Try a different name or address.
            </Text>
          ) : null}
          {destination ? <TextButton label="Cancel" onPress={cancel} disabled={saving} /> : null}
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
  results: { gap: spacing[2] },
  result: {
    minHeight: 52,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
    justifyContent: 'center',
  },
  primary: { fontSize: fontSize.base, fontWeight: fontWeight.medium },
});
