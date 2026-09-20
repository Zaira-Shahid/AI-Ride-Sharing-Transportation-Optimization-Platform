import { describeAuthError } from '@ridemesh/firebase';
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
import { Notice, TextField, useAuthTheme } from '../components';

const SEARCH_DELAY_MS = 300;

/** What a person is told when the place search fails. Never the raw error. */
export function placesMessage(error: unknown): string {
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

/**
 * Thrown by an onPick that does not want the place it was given (for example a pickup that is the
 * same place as the destination). Its message is shown to the person as it is, so it must already be
 * written for them.
 */
export class PlaceRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaceRejectedError';
  }
}

interface Props {
  /** The Maps Platform key for this build, if one was configured. */
  placesApiKey: string | undefined;
  /** The label of the search box, for example "Search for a destination". */
  label: string;
  /**
   * Called with the place the person picked: coordinates and address from Google, never typed by
   * the person. What happens to it (saving it, keeping it in the app) is up to the caller; if this
   * throws, the search shows why and stays open so the person can pick again (a PlaceRejectedError
   * is shown with its own message; anything else gets a general one).
   */
  onPick: (place: StoredDestination) => Promise<void> | void;
  /** Describes the wait after a suggestion is picked, for screen readers. */
  busyLabel: string;
}

/**
 * Searches for a place with Google Places autocomplete and hands the picked one to the caller.
 * Picking a suggestion is enough, nothing more has to be typed. Used by the driver's destination
 * and by the passenger's pickup and destination.
 */
export function PlaceSearch({ placesApiKey, label, onPick, busyLabel }: Props) {
  const theme = useAuthTheme();
  const places = useMemo(() => ({ apiKey: placesApiKey }), [placesApiKey]);

  const [query, setQuery] = useState('');
  const [session, setSession] = useState(createSessionToken);
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [searched, setSearched] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [pickFailure, setPickFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    setPickFailure(null);
    setBusy(true);
    try {
      const place = await getPlaceDestination(places, suggestion.placeId, session);
      await onPick(place);
      setQuery('');
      setSuggestions([]);
      // A picked place ends the search session; the next search starts a new one.
      setSession(createSessionToken());
    } catch (error) {
      setPickFailure(
        error instanceof PlaceRejectedError
          ? error.message
          : error instanceof PlacesError
            ? placesMessage(error)
            : describeAuthError(error).message,
      );
    } finally {
      setBusy(false);
    }
  };

  if (!placesApiKey) {
    return <Notice tone="error">{placesMessage(new PlacesError('not-configured', ''))}</Notice>;
  }

  return (
    <View style={styles.search}>
      {pickFailure ? <Notice tone="error">{pickFailure}</Notice> : null}
      <TextField
        label={label}
        value={query}
        onChangeText={setQuery}
        autoCapitalize="words"
        returnKeyType="search"
        editable={!busy}
      />
      {searchError ? <Notice tone="error">{searchError}</Notice> : null}
      {busy ? <ActivityIndicator accessibilityLabel={busyLabel} color={theme.accent} /> : null}
      {suggestions.length > 0 ? (
        <View role="list" style={styles.results}>
          {suggestions.map((suggestion) => (
            <Pressable
              key={suggestion.placeId}
              role="button"
              aria-label={suggestion.text}
              aria-disabled={busy}
              disabled={busy}
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
          <Text style={[styles.caption, { color: theme.textSecondary }]}>Powered by Google</Text>
        </View>
      ) : searched && !searchError ? (
        <Text style={[styles.caption, { color: theme.textSecondary }]}>
          No places found. Try a different name or address.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  search: { gap: spacing[3] },
  caption: { fontSize: fontSize.sm },
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
