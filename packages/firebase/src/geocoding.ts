import {
  roundForGeocoding,
  type ReverseGeocodeInput,
  type ReverseGeocodeResult,
  type ReverseGeocodeStatus,
} from '@ridemesh/types';
import { httpsCallable } from 'firebase/functions';
import type { FirebaseClient } from './client';

/** What became of a lookup: the server's status, or 'failed' when nothing usable came back. */
export type ReverseGeocodeOutcome = ReverseGeocodeStatus | 'failed';

/** How long the app waits for an address before it carries on without one. */
export const REVERSE_GEOCODE_WAIT_MS = 8_000;

/**
 * Asks the server for the address of a position (reverse geocoding, Module 4.2), through the
 * reverseGeocode function. The position is rounded to about 11 m here, before it leaves the device,
 * so the exact position never reaches the function or anyone after it; the server rounds it again
 * (it does not trust the app) before it asks anyone, and remembers answers by that rounded position
 * alone.
 *
 * An address is a nicety and never a requirement, so this never throws and never makes anyone wait
 * long: it returns the address, or null when there is none, the lookup failed, the server was busy,
 * or `waitMs` passed. The caller then keeps calling the place "Current location". The reason is
 * given to `onOutcome` for the callers that want to know (tests, mostly).
 */
export async function reverseGeocode(
  client: Pick<FirebaseClient, 'functions'>,
  point: ReverseGeocodeInput,
  options: { waitMs?: number; onOutcome?: (outcome: ReverseGeocodeOutcome) => void } = {},
): Promise<string | null> {
  const report = options.onOutcome ?? (() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const lookup = httpsCallable<ReverseGeocodeInput, ReverseGeocodeResult>(
      client.functions,
      'reverseGeocode',
    )(roundForGeocoding(point));
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), options.waitMs ?? REVERSE_GEOCODE_WAIT_MS);
    });
    const result = await Promise.race([lookup, timeout]);
    if (result === null) {
      report('failed');
      return null;
    }
    report(result.data.status);
    return result.data.status === 'found' && result.data.address ? result.data.address : null;
  } catch {
    report('failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}
