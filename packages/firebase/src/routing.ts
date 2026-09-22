import {
  roundStopsForRouting,
  type CalculateRouteInput,
  type CalculateRouteResult,
  type GeocodePoint,
  type Route,
  type RouteProfile,
  type RouteStatus,
} from '@ridemesh/types';
import { httpsCallable } from 'firebase/functions';
import type { FirebaseClient } from './client';

/** What became of a route lookup: the server's status, or 'failed' when nothing usable came back. */
export type RouteOutcome = RouteStatus | 'failed';

/** How long the app waits for a route before it carries on without one. */
export const CALCULATE_ROUTE_WAIT_MS = 12_000;

/**
 * Asks the server for the route through the stops (Module 4.3; by road, or on foot with 4.6),
 * through the calculateRoute function: distance in metres, time in seconds (free-flow: there is no traffic in it) and the line,
 * in total and for each leg. The stops are rounded to about 11 m here, before they leave the device,
 * so the exact positions never reach the function or anyone after it; the server rounds them again
 * (it does not trust the app) before it asks anyone, and remembers routes by the rounded stops alone.
 *
 * A route is a help and never a requirement, so this never throws and never makes anyone wait long:
 * it returns the route, or null when there is none, the lookup failed, the server was busy, or
 * `waitMs` passed. The reason is given to `onOutcome` for the callers that want to know.
 */
export async function calculateRoute(
  client: Pick<FirebaseClient, 'functions'>,
  stops: readonly GeocodePoint[],
  options: {
    /** By road (the default) or on foot. */
    profile?: RouteProfile;
    waitMs?: number;
    onOutcome?: (outcome: RouteOutcome) => void;
  } = {},
): Promise<Route | null> {
  const report = options.onOutcome ?? (() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const lookup = httpsCallable<CalculateRouteInput, CalculateRouteResult>(
      client.functions,
      'calculateRoute',
    )({
      stops: roundStopsForRouting(stops),
      // Only said when it is not the default, so a request for a road route is what it always was.
      ...(options.profile && options.profile !== 'driving' ? { profile: options.profile } : {}),
    });
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), options.waitMs ?? CALCULATE_ROUTE_WAIT_MS);
    });
    const result = await Promise.race([lookup, timeout]);
    if (result === null) {
      report('failed');
      return null;
    }
    report(result.data.status);
    return result.data.status === 'found' ? result.data.route : null;
  } catch {
    report('failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}
