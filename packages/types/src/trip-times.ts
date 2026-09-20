// When a passenger wants to travel. Times are instants, kept as milliseconds since 1970 (UTC), so
// they mean the same thing on every device and on the server; the apps show them in the device's own
// time zone. Module 3.7 stores them as UTC timestamps on the trip request and must repeat
// checkTripTimes on the server, with the server's clock (a device's clock can be wrong).

export const MINUTE_MS = 60_000;
export const DAY_MS = 24 * 60 * MINUTE_MS;

/** A time asked for must be at least this many minutes from now: too soon leaves nothing to match. */
export const MIN_LEAD_MINUTES = 5;
/** ...and at most this many days from now. */
export const MAX_AHEAD_DAYS = 7;
/** Times are chosen in steps of this many minutes. */
export const TIME_STEP_MINUTES = 5;
/** An arrival time must be at least this many minutes after the departure. */
export const MIN_ARRIVAL_GAP_MINUTES = 1;

/** Leaving now (as soon as a ride is found), or at a time chosen. */
export type Departure = { kind: 'NOW' } | { kind: 'AT'; at: number };

export interface TripTimes {
  departure: Departure;
  /** The time the passenger must be there by, or null for no deadline. */
  arriveBy: number | null;
}

/** What a passenger gets when they choose nothing: leave now, with no arrival time. */
export const DEFAULT_TRIP_TIMES: TripTimes = { departure: { kind: 'NOW' }, arriveBy: null };

export type TimeProblem = 'INVALID' | 'TOO_SOON' | 'TOO_FAR';

/**
 * Whether a time asked for is acceptable when it is `now`: a real time, at least MIN_LEAD_MINUTES
 * from now (exactly that is fine) and at most MAX_AHEAD_DAYS from now (exactly that is fine).
 */
export function findTimeProblem(at: number, now: number): TimeProblem | null {
  if (typeof at !== 'number' || !Number.isFinite(at)) return 'INVALID';
  if (at < now + MIN_LEAD_MINUTES * MINUTE_MS) return 'TOO_SOON';
  if (at > now + MAX_AHEAD_DAYS * DAY_MS) return 'TOO_FAR';
  return null;
}

export interface TripTimesProblem {
  field: 'departure' | 'arriveBy';
  problem: TimeProblem | 'NOT_AFTER_DEPARTURE';
}

/**
 * The first thing wrong with the times of a trip, or null when they are fine. "Leave now" is always
 * fine; a chosen departure and any arrival time must each be acceptable (findTimeProblem), and the
 * arrival must come at least MIN_ARRIVAL_GAP_MINUTES after the departure (after `now` when leaving
 * now). Whether the trip can be made in the time is for routing (Phase 4), not for this check.
 */
export function checkTripTimes(times: TripTimes, now: number): TripTimesProblem | null {
  if (times.departure.kind === 'AT') {
    const problem = findTimeProblem(times.departure.at, now);
    if (problem) return { field: 'departure', problem };
  }
  if (times.arriveBy !== null) {
    const problem = findTimeProblem(times.arriveBy, now);
    if (problem) return { field: 'arriveBy', problem };
    const departsAt = times.departure.kind === 'AT' ? times.departure.at : now;
    if (times.arriveBy < departsAt + MIN_ARRIVAL_GAP_MINUTES * MINUTE_MS) {
      return { field: 'arriveBy', problem: 'NOT_AFTER_DEPARTURE' };
    }
  }
  return null;
}

const STEP_MS = TIME_STEP_MINUTES * MINUTE_MS;

/** The first moment on the step grid (a multiple of 5 minutes, which is a whole clock time) at or after `at`. */
export function roundUpToStep(at: number): number {
  return Math.ceil(at / STEP_MS) * STEP_MS;
}

/** The last moment on the step grid at or before `at`. */
export function roundDownToStep(at: number): number {
  return Math.floor(at / STEP_MS) * STEP_MS;
}

/** Every moment on the step grid from `from` to `to`, both included when they are on it. */
export function listSlots(from: number, to: number): number[] {
  const slots: number[] = [];
  for (let at = roundUpToStep(from); at <= to; at += STEP_MS) slots.push(at);
  return slots;
}

/** The times a passenger can choose to leave at: the first is the earliest time that is allowed. */
export function departureSlots(now: number): number[] {
  return listSlots(now + MIN_LEAD_MINUTES * MINUTE_MS, now + MAX_AHEAD_DAYS * DAY_MS);
}

/** The times a passenger can choose to arrive by, given when they leave. */
export function arrivalSlots(now: number, departure: Departure): number[] {
  const departsAt = departure.kind === 'AT' ? departure.at : now;
  return listSlots(
    Math.max(now + MIN_LEAD_MINUTES * MINUTE_MS, departsAt + MIN_ARRIVAL_GAP_MINUTES * MINUTE_MS),
    now + MAX_AHEAD_DAYS * DAY_MS,
  );
}

export interface SlotMinute {
  minute: number;
  at: number;
}
export interface SlotHour {
  hour: number;
  minutes: SlotMinute[];
}
export interface SlotDay {
  /** The local calendar day, for example "2026-09-20". */
  key: string;
  /** The first time on the day, to name it from. */
  first: number;
  hours: SlotHour[];
}

const pad = (value: number) => String(value).padStart(2, '0');

/** The local calendar day of a time, in the device's time zone, for example "2026-09-20". */
export function localDayKey(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Groups times by the local day, hour and minute they fall on in the device's time zone, for a
 * picker to offer as days, then hours, then minutes. A clock time that happens twice (when the clocks
 * go back) is offered once, as its first time; one that never happens (when they go forward) is not
 * offered.
 */
export function groupSlots(slots: readonly number[]): SlotDay[] {
  const days: SlotDay[] = [];
  for (const at of slots) {
    const date = new Date(at);
    const key = localDayKey(at);
    let day = days.at(-1);
    if (day?.key !== key) {
      day = { key, first: at, hours: [] };
      days.push(day);
    }
    let hour = day.hours.at(-1);
    if (hour?.hour !== date.getHours()) {
      hour = { hour: date.getHours(), minutes: [] };
      day.hours.push(hour);
    }
    if (!hour.minutes.some((entry) => entry.minute === date.getMinutes())) {
      hour.minutes.push({ minute: date.getMinutes(), at });
    }
  }
  return days;
}

/** How far into its local day a time is, in minutes. */
export function minuteOfDay(at: number): number {
  const date = new Date(at);
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * When a passenger picks another day, keep the time of day if it can be had: the time on that day
 * closest to `current`'s time of day (the first time on the day when there is no current).
 */
export function timeOnDay(day: SlotDay, current: number | null): number {
  const times = day.hours.flatMap((hour) => hour.minutes.map((minute) => minute.at));
  return closestByTimeOfDay(times, current);
}

/** When a passenger picks another hour, keep the minute of the hour if it can be had. */
export function timeInHour(hour: SlotHour, current: number | null): number {
  const first = hour.minutes[0];
  if (first === undefined) throw new Error('There are no times to choose from.');
  if (current === null) return first.at;
  const wanted = new Date(current).getMinutes();
  let best = first;
  for (const entry of hour.minutes) {
    if (Math.abs(entry.minute - wanted) < Math.abs(best.minute - wanted)) best = entry;
  }
  return best.at;
}

function closestByTimeOfDay(times: readonly number[], current: number | null): number {
  const first = times[0];
  if (first === undefined) throw new Error('There are no times to choose from.');
  if (current === null) return first;
  const wanted = minuteOfDay(current);
  let best = first;
  for (const at of times) {
    if (Math.abs(minuteOfDay(at) - wanted) < Math.abs(minuteOfDay(best) - wanted)) best = at;
  }
  return best;
}
