import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { isStaffRole } from './roles.js';
import { TRIP_RETENTION_BATCH_SIZE, type TripRetentionOutcome } from './tripRetention.js';
import type { StaffCaller } from './verification.js';

// Phase 14 (Monitoring, spec section 54): the counts of two kinds of failure that were only ever
// logged, never counted - route lookups that did not give a route, and Cloud Function triggers and
// sweeps whose own try/catch caught an exception. Nothing else, and nothing about who or where:
// a count and a kind. docs/security.md ("Monitoring / observability") has the whole picture.
//
// A count is one Firestore increment, best effort: recordOpsEvent never throws and never fails the
// operation it is counting, so a failed write is a missed count, not a failed trip. Counters are
// daily (UTC) and split over OPS_SHARDS documents per day, so that a burst of failures (50 lookups
// refused in the same second) does not pile up on one document the way the route counter itself once
// did (docs/load-testing.md). The panel adds the shards up.
//
// What cannot be counted from inside: a function that crashes, runs out of memory or times out never
// reaches its catch block, so it is not counted here. Those are in Cloud Logging and Cloud
// Monitoring only. The page says so.

export const OPS_COLLECTION = 'opsCounters';
export const OPS_SHARDS = 10;
export const OPS_RETENTION_DAYS = 30;

export const ROUTE_UNAVAILABLE = 'route-unavailable';
export const ROUTE_BUSY = 'route-busy';
const FUNCTION_FAILED = 'function-failed:';
export const functionFailedKind = (name: string) => `${FUNCTION_FAILED}${name}`;

const DAY_MS = 86_400_000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The UTC day of a moment, like 2026-10-03. */
export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Counts one occurrence of `kind` today. Never throws and never waits on anything but its one write;
 * a counter that cannot be written is simply not counted.
 */
export async function recordOpsEvent(
  firestore: Firestore,
  kind: string,
  deps: { now?: () => number; shard?: number } = {},
): Promise<void> {
  try {
    const now = (deps.now ?? Date.now)();
    const day = dayOf(now);
    const shard = deps.shard ?? Math.floor(Math.random() * OPS_SHARDS);
    await firestore
      .collection(OPS_COLLECTION)
      .doc(`${day}_${shard}`)
      .set({ day, counts: { [kind]: FieldValue.increment(1) } }, { merge: true });
  } catch {
    // A missed count must never become a failed operation.
  }
}

/** One stretch of days, added up. */
export interface OperationsPeriod {
  fromDay: string;
  toDay: string;
  routeUnavailable: number;
  routeBusy: number;
  /** Caught exceptions per function or sweep name. */
  functionFailures: Record<string, number>;
}

export interface OperationsDay {
  day: string;
  routeUnavailable: number;
  routeBusy: number;
  functionFailures: number;
}

export interface OperationsSummary {
  generatedAt: number;
  /** The UTC day so far. Not a trailing 24 hours: counters are per day. */
  today: OperationsPeriod;
  /** Today and the six UTC days before it. */
  last7Days: OperationsPeriod;
  /** The same seven days, oldest first. */
  days: OperationsDay[];
  retentionDays: number;
}

function requireStaff(caller: StaffCaller): void {
  if (!isStaffRole(caller.role) || !caller.emailVerified) {
    throw new HttpsError('permission-denied', 'You are not allowed to view operations.');
  }
}

const emptyPeriod = (fromDay: string, toDay: string): OperationsPeriod => ({
  fromDay,
  toDay,
  routeUnavailable: 0,
  routeBusy: 0,
  functionFailures: {},
});

function addTo(period: OperationsPeriod, counts: Record<string, unknown>) {
  for (const [kind, value] of Object.entries(counts)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    if (kind === ROUTE_UNAVAILABLE) period.routeUnavailable += value;
    else if (kind === ROUTE_BUSY) period.routeBusy += value;
    else if (kind.startsWith(FUNCTION_FAILED)) {
      const name = kind.slice(FUNCTION_FAILED.length);
      period.functionFailures[name] = (period.functionFailures[name] ?? 0) + value;
    }
  }
}

/**
 * The counts for today and for the last seven UTC days, for any verified staff role. Reads at most
 * 7 x OPS_SHARDS small documents, however much has happened.
 */
export async function getOperationsSummaryForStaff(
  deps: { firestore: Firestore; now?: () => number },
  caller: StaffCaller,
): Promise<OperationsSummary> {
  requireStaff(caller);
  const now = (deps.now ?? Date.now)();
  const today = dayOf(now);
  const dayList = Array.from({ length: 7 }, (_, i) => dayOf(now - (6 - i) * DAY_MS));
  const snapshot = await deps.firestore
    .collection(OPS_COLLECTION)
    .where('day', '>=', dayList[0]!)
    .get();

  const todayPeriod = emptyPeriod(today, today);
  const week = emptyPeriod(dayList[0]!, today);
  const perDay = new Map<string, OperationsPeriod>(dayList.map((d) => [d, emptyPeriod(d, d)]));
  for (const doc of snapshot.docs) {
    const day: unknown = doc.get('day');
    const counts: unknown = doc.get('counts');
    if (typeof day !== 'string' || !perDay.has(day)) continue;
    if (typeof counts !== 'object' || counts === null) continue;
    addTo(week, counts as Record<string, unknown>);
    addTo(perDay.get(day)!, counts as Record<string, unknown>);
    if (day === today) addTo(todayPeriod, counts as Record<string, unknown>);
  }

  return {
    generatedAt: now,
    today: todayPeriod,
    last7Days: week,
    days: dayList.map((day) => {
      const period = perDay.get(day)!;
      return {
        day,
        routeUnavailable: period.routeUnavailable,
        routeBusy: period.routeBusy,
        functionFailures: Object.values(period.functionFailures).reduce((a, b) => a + b, 0),
      };
    }),
    retentionDays: OPS_RETENTION_DAYS,
  };
}

/**
 * Deletes the daily counter documents older than OPS_RETENTION_DAYS, up to one batch. Same shape as
 * the other retention routines (tripRetention.ts), so the same runner works through a backlog.
 */
export async function clearExpiredOpsCounters(deps: {
  firestore: Firestore;
  now?: () => number;
}): Promise<TripRetentionOutcome> {
  const now = (deps.now ?? Date.now)();
  const cutoffDay = dayOf(now - OPS_RETENTION_DAYS * DAY_MS);
  const expired = await deps.firestore
    .collection(OPS_COLLECTION)
    .where('day', '<', cutoffDay)
    .limit(TRIP_RETENTION_BATCH_SIZE)
    .get();
  const writer = deps.firestore.batch();
  let cleared = 0;
  for (const doc of expired.docs) {
    const day: unknown = doc.get('day');
    if (typeof day !== 'string' || !DAY_PATTERN.test(day)) continue;
    writer.delete(doc.ref);
    cleared += 1;
  }
  if (cleared > 0) await writer.commit();
  return { checked: expired.size, cleared };
}
