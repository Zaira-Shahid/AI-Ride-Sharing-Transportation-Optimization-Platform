import { Timestamp } from 'firebase-admin/firestore';
import type { PlanLeg } from './planInsertion.js';

// Module 8.6 (traffic delay): with no live traffic-aware routing provider in the system (Module 4.3's
// own routing is free-flow only - see calculateRoute's own note), the only delay signal actually
// available is self-detected drift: how far behind the plan's own allotted pace the driver is, purely
// from elapsed wall-clock time against the plan's own per-leg durations (Module 8.3/8.4's own `legs`,
// added alongside `stops` for exactly this). Checked from updateDriverLocation (Module 7.1) on every
// location update, reusing data that call already reads - no new schedule, no new routing call.
//
// Flags only once the whole CURRENT leg's own allotted time is exceeded by DELAY_THRESHOLD_MINUTES or
// more, not the moment a leg starts (every leg budgets some driving time; overrunning it, not merely
// being mid-leg, is the signal) - so a driver who has simply not reached the next stop yet is never
// mistaken for a delayed one. It clears itself the next time a stop completes and unlocks a fresh
// leg's own budget, and needs no separate "catching up" logic: the comparison is recomputed fresh
// every time, from the plan's own data and the current wall clock, never from a stored delta.
//
// Detection only (as scoped): this module only computes and reports the flag. Module 8.7 (route
// modification) and Module 8.9 (notification) are the ones that will act on it.

export const DELAY_THRESHOLD_MINUTES = 5;

interface StopEntry {
  kind: 'pickup' | 'dropoff';
  requestId: string;
}

export interface DelayFlag {
  extraMinutes: number;
}

const PICKED_UP_OR_LATER = new Set(['PICKED_UP', 'IN_TRANSIT', 'DROPOFF_APPROACHING', 'COMPLETED']);

function stopIsDone(stop: StopEntry, status: string | undefined): boolean {
  if (status === undefined) return false;
  return stop.kind === 'pickup' ? PICKED_UP_OR_LATER.has(status) : status === 'COMPLETED';
}

function parseStops(raw: unknown): StopEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const stops: StopEntry[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { kind, requestId } = entry as Record<string, unknown>;
    if ((kind !== 'pickup' && kind !== 'dropoff') || typeof requestId !== 'string') return null;
    stops.push({ kind, requestId });
  }
  return stops;
}

function parseLegs(raw: unknown): PlanLeg[] | null {
  if (!Array.isArray(raw)) return null;
  const legs: PlanLeg[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { distanceMeters, durationSeconds } = entry as Record<string, unknown>;
    if (typeof distanceMeters !== 'number' || typeof durationSeconds !== 'number') return null;
    legs.push({ distanceMeters, durationSeconds });
  }
  return legs;
}

/**
 * Whether the plan currently backing a journey shows a driver behind its own pace, given every one
 * of its matched requests' own current status. Returns null both when there is nothing to flag and
 * when the plan cannot be read (no legs - e.g. written before this module existed, or by a version
 * that could not recover them - or a malformed stops/createdAt) - the two are deliberately
 * indistinguishable to the caller, since "no data" and "on schedule" both mean: do not flag it.
 */
export function computeDelayFlag(
  plan: { stops: unknown; legs: unknown; createdAt: unknown },
  tripStatusById: ReadonlyMap<string, string | undefined>,
  now: number,
): DelayFlag | null {
  const stops = parseStops(plan.stops);
  const legs = parseLegs(plan.legs);
  if (!stops || !legs || legs.length !== stops.length + 1) return null;
  if (!(plan.createdAt instanceof Timestamp)) return null;

  let stopIndex = stops.length;
  for (let i = 0; i < stops.length; i += 1) {
    if (!stopIsDone(stops[i]!, tripStatusById.get(stops[i]!.requestId))) {
      stopIndex = i;
      break;
    }
  }

  // The plan's own allotted time to reach the end of whichever leg is currently in progress (the one
  // leading to the next not-yet-done stop, or the final leg to the destination once every stop is
  // done) - legs[0..stopIndex] inclusive.
  const expectedSeconds = legs
    .slice(0, stopIndex + 1)
    .reduce((sum, leg) => sum + leg.durationSeconds, 0);
  const actualSeconds = (now - plan.createdAt.toMillis()) / 1000;
  const extraMinutes = Math.floor((actualSeconds - expectedSeconds) / 60);

  return extraMinutes >= DELAY_THRESHOLD_MINUTES ? { extraMinutes } : null;
}
