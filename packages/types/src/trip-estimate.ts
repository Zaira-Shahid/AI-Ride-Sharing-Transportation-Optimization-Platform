// The estimate of a trip request (Modules 4.4 and 4.5): how far and how long the road route from the
// pickup to the destination is. The server fills it in just after the request is created, from a
// route (docs/architecture.md, "Trip estimate"), and the app shows it before the passenger confirms
// and afterwards. It is stored on the request as `estimatedDistance` in METRES and
// `estimatedDuration` in whole SECONDS (what a route has; the apps turn them into km and minutes for
// people). There is no traffic in it: OSRM has none, so the time is a free-flow estimate, and every
// place that shows it says so.

/** What the estimate is, in the words shown next to it. */
export const ESTIMATE_CAVEAT = 'Estimated without live traffic.';

/**
 * How long a request may wait for its estimate before the app stops saying "estimating" and says it
 * could not be made. The server normally takes a second or two; it does not retry for long, so an
 * estimate that has not come by then is not coming.
 */
export const ESTIMATE_WAIT_MS = 30_000;

export interface TripEstimate {
  distanceMeters: number;
  durationSeconds: number;
}

const isMeasure = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** The estimate stored on a request, or null when either half is missing or not a number. */
export function readTripEstimate(distance: unknown, duration: unknown): TripEstimate | null {
  return isMeasure(distance) && isMeasure(duration)
    ? { distanceMeters: distance, durationSeconds: duration }
    : null;
}

/**
 * Where a request's estimate stands: `READY` when it has one, `WAITING` while it is still being
 * worked out, and `UNAVAILABLE` once ESTIMATE_WAIT_MS has passed since the request was made without
 * one (the routing server was down or found no route). It is only ever a note for the passenger:
 * nothing depends on it.
 */
export function estimateProgress(
  trip: { estimate: TripEstimate | null; requestedAt: number | null },
  now: number,
): 'READY' | 'WAITING' | 'UNAVAILABLE' {
  if (trip.estimate) return 'READY';
  if (trip.requestedAt !== null && now - trip.requestedAt >= ESTIMATE_WAIT_MS) return 'UNAVAILABLE';
  return 'WAITING';
}

/** A distance for people: "850 m", "8.2 km", "180 km". */
export function formatDistance(meters: number): string {
  const rounded = Math.round(meters / 10) * 10;
  if (rounded < 1000) return `${Math.max(rounded, 0)} m`;
  const km = meters / 1000;
  // One decimal below 100 km, none above; "1.0 km" is written "1 km".
  return `${km < 100 ? Number(km.toFixed(1)) : Math.round(km)} km`;
}

/** A time for people: "under 1 min", "18 min", "1 h", "1 h 5 min". */
export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return 'under 1 min';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** "18 min, 8.2 km": the two halves of an estimate together. */
export function describeEstimate(estimate: TripEstimate): string {
  return `${formatDuration(estimate.durationSeconds)}, ${formatDistance(estimate.distanceMeters)}`;
}

/**
 * How many minutes too short the passenger's arrival time is for the estimated trip: 0 when there is
 * no arrival time or the trip fits. The trip starts at the chosen departure, or now for "leave now".
 * It is a warning and never a refusal: the estimate has no traffic and no detours for sharing, so it
 * cannot be trusted to turn a request away.
 */
export function arrivalShortfallMinutes(input: {
  /** The chosen departure in ms since 1970, or null for "leave now". */
  departureAt: number | null;
  now: number;
  /** The time to arrive by in ms since 1970, or null for none. */
  arriveBy: number | null;
  durationSeconds: number;
}): number {
  if (input.arriveBy === null) return 0;
  const arrivesAt = (input.departureAt ?? input.now) + input.durationSeconds * 1000;
  return arrivesAt > input.arriveBy ? Math.ceil((arrivesAt - input.arriveBy) / 60_000) : 0;
}
