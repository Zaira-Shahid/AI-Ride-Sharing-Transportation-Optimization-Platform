import { afterAll, describe, expect, it } from 'vitest';
import {
  DAY_MS,
  DEFAULT_TRIP_TIMES,
  MAX_AHEAD_DAYS,
  MIN_ARRIVAL_GAP_MINUTES,
  MIN_LEAD_MINUTES,
  MINUTE_MS,
  TIME_STEP_MINUTES,
  arrivalSlots,
  checkTripTimes,
  departureSlots,
  findTimeProblem,
  groupSlots,
  listSlots,
  localDayKey,
  minuteOfDay,
  roundDownToStep,
  roundUpToStep,
  timeInHour,
  timeOnDay,
} from '../packages/types/src/trip-times';

// 10:58 in London (BST) on Sunday 20 September 2026.
const NOW = Date.parse('2026-09-20T09:58:00Z');
const inMinutes = (minutes: number) => NOW + minutes * MINUTE_MS;

// The zone is set here, when the file loads, because some tests work out local days while the tests
// are being collected, before any beforeAll runs. The machine's own zone is put back at the end.
const originalZone = process.env.TZ;
process.env.TZ = 'Europe/London';
afterAll(() => {
  if (originalZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalZone;
});

describe('the rules', () => {
  it('are the ones agreed: 5 minutes to 7 days, in steps of 5, arrival 1 minute after departure', () => {
    expect(MIN_LEAD_MINUTES).toBe(5);
    expect(MAX_AHEAD_DAYS).toBe(7);
    expect(TIME_STEP_MINUTES).toBe(5);
    expect(MIN_ARRIVAL_GAP_MINUTES).toBe(1);
  });
});

describe('findTimeProblem', () => {
  it('refuses a time less than 5 minutes away, and accepts exactly 5 minutes', () => {
    expect(findTimeProblem(NOW, NOW)).toBe('TOO_SOON');
    expect(findTimeProblem(inMinutes(4.999), NOW)).toBe('TOO_SOON');
    expect(findTimeProblem(NOW - DAY_MS, NOW)).toBe('TOO_SOON');
    expect(findTimeProblem(inMinutes(5), NOW)).toBeNull();
  });

  it('refuses a time more than 7 days away, and accepts exactly 7 days', () => {
    expect(findTimeProblem(NOW + 7 * DAY_MS, NOW)).toBeNull();
    expect(findTimeProblem(NOW + 7 * DAY_MS + 1, NOW)).toBe('TOO_FAR');
    expect(findTimeProblem(NOW + 30 * DAY_MS, NOW)).toBe('TOO_FAR');
  });

  it('accepts times in between', () => {
    expect(findTimeProblem(inMinutes(30), NOW)).toBeNull();
    expect(findTimeProblem(NOW + 3 * DAY_MS, NOW)).toBeNull();
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '2026-09-21' as unknown as number,
    null as unknown as number,
  ])('refuses %s as not a time', (value) => {
    expect(findTimeProblem(value, NOW)).toBe('INVALID');
  });
});

describe('checkTripTimes', () => {
  it('accepts the default: leave now, no arrival time', () => {
    expect(checkTripTimes(DEFAULT_TRIP_TIMES, NOW)).toBeNull();
  });

  it('accepts a chosen departure with or without an arrival time', () => {
    const departure = { kind: 'AT', at: inMinutes(60) } as const;
    expect(checkTripTimes({ departure, arriveBy: null }, NOW)).toBeNull();
    expect(checkTripTimes({ departure, arriveBy: inMinutes(120) }, NOW)).toBeNull();
  });

  it('accepts an arrival time when leaving now, from 5 minutes away', () => {
    expect(checkTripTimes({ departure: { kind: 'NOW' }, arriveBy: inMinutes(5) }, NOW)).toBeNull();
    expect(checkTripTimes({ departure: { kind: 'NOW' }, arriveBy: inMinutes(4) }, NOW)).toEqual({
      field: 'arriveBy',
      problem: 'TOO_SOON',
    });
  });

  it('names the field that is wrong, checking the departure first', () => {
    expect(
      checkTripTimes({ departure: { kind: 'AT', at: inMinutes(2) }, arriveBy: inMinutes(1) }, NOW),
    ).toEqual({ field: 'departure', problem: 'TOO_SOON' });
    expect(
      checkTripTimes({ departure: { kind: 'AT', at: NOW + 8 * DAY_MS }, arriveBy: null }, NOW),
    ).toEqual({ field: 'departure', problem: 'TOO_FAR' });
    expect(checkTripTimes({ departure: { kind: 'NOW' }, arriveBy: NOW + 8 * DAY_MS }, NOW)).toEqual(
      { field: 'arriveBy', problem: 'TOO_FAR' },
    );
  });

  it('needs the arrival to be at least a minute after the departure', () => {
    const departure = { kind: 'AT', at: inMinutes(60) } as const;
    const problem = { field: 'arriveBy', problem: 'NOT_AFTER_DEPARTURE' };
    expect(checkTripTimes({ departure, arriveBy: inMinutes(30) }, NOW)).toEqual(problem);
    expect(checkTripTimes({ departure, arriveBy: inMinutes(60) }, NOW)).toEqual(problem);
    expect(checkTripTimes({ departure, arriveBy: inMinutes(60) + 59_999 }, NOW)).toEqual(problem);
    expect(checkTripTimes({ departure, arriveBy: inMinutes(61) }, NOW)).toBeNull();
  });
});

describe('the step grid', () => {
  it('rounds up and down to whole 5-minute clock times', () => {
    const at = Date.parse('2026-09-20T10:03:20Z');
    expect(new Date(roundUpToStep(at)).toISOString()).toBe('2026-09-20T10:05:00.000Z');
    expect(new Date(roundDownToStep(at)).toISOString()).toBe('2026-09-20T10:00:00.000Z');
    const onGrid = Date.parse('2026-09-20T10:05:00Z');
    expect(roundUpToStep(onGrid)).toBe(onGrid);
    expect(roundDownToStep(onGrid)).toBe(onGrid);
  });

  it('lists every step between two times, both ends included when they are on the grid', () => {
    const from = Date.parse('2026-09-20T10:00:00Z');
    expect(listSlots(from, from + 15 * MINUTE_MS)).toEqual([
      from,
      from + 5 * MINUTE_MS,
      from + 10 * MINUTE_MS,
      from + 15 * MINUTE_MS,
    ]);
    expect(listSlots(from + 1, from + 9 * MINUTE_MS)).toEqual([from + 5 * MINUTE_MS]);
    expect(listSlots(from + 10, from + 20)).toEqual([]);
  });
});

describe('the times that can be chosen', () => {
  it('start at the first step 5 minutes away and end at the last step within 7 days', () => {
    const slots = departureSlots(NOW);
    // 10:58 + 5 minutes is 11:03 (BST), so the first step is 11:05 BST = 10:05Z.
    expect(new Date(slots[0] ?? 0).toISOString()).toBe('2026-09-20T10:05:00.000Z');
    expect(new Date(slots.at(-1) ?? 0).toISOString()).toBe('2026-09-27T09:55:00.000Z');
    expect(slots.every((at) => findTimeProblem(at, NOW) === null)).toBe(true);
    expect(slots.every((at) => at % (TIME_STEP_MINUTES * MINUTE_MS) === 0)).toBe(true);
  });

  it('are exactly the times checkTripTimes accepts on the grid', () => {
    const slots = departureSlots(NOW);
    expect(findTimeProblem((slots[0] ?? 0) - 5 * MINUTE_MS, NOW)).toBe('TOO_SOON');
    expect(findTimeProblem((slots.at(-1) ?? 0) + 5 * MINUTE_MS, NOW)).toBe('TOO_FAR');
  });

  it('for an arrival start at the departure plus a minute (the next step), or 5 minutes from now', () => {
    const leavingNow = arrivalSlots(NOW, { kind: 'NOW' });
    expect(new Date(leavingNow[0] ?? 0).toISOString()).toBe('2026-09-20T10:05:00.000Z');

    const departure = { kind: 'AT', at: Date.parse('2026-09-20T13:00:00Z') } as const;
    const later = arrivalSlots(NOW, departure);
    // 13:00Z plus a minute is 13:01Z, so the first step is 13:05Z.
    expect(new Date(later[0] ?? 0).toISOString()).toBe('2026-09-20T13:05:00.000Z');
    expect(later.every((at) => checkTripTimes({ departure, arriveBy: at }, NOW) === null)).toBe(
      true,
    );
  });

  it('for an arrival are empty when the departure is too close to the end of the window', () => {
    const departure = { kind: 'AT', at: NOW + 7 * DAY_MS } as const;
    expect(arrivalSlots(NOW, departure)).toEqual([]);
  });
});

describe("grouping times by the device's local day, hour and minute", () => {
  it('uses the device time zone: London is an hour ahead of UTC in September', () => {
    const days = groupSlots(departureSlots(NOW));
    const today = days[0];
    expect(today?.key).toBe('2026-09-20');
    expect(today?.hours[0]?.hour).toBe(11);
    expect(today?.hours[0]?.minutes.map((entry) => entry.minute)).toEqual([
      5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55,
    ]);
    expect(today?.hours.at(-1)?.hour).toBe(23);
    // Today, tomorrow and so on to seven days ahead: eight local days in all.
    expect(days).toHaveLength(8);
    expect(days.at(-1)?.key).toBe('2026-09-27');
    expect(days.at(-1)?.hours.at(-1)?.hour).toBe(10);
    expect(days.at(-1)?.hours.at(-1)?.minutes.at(-1)?.minute).toBe(55);
  });

  it('follows the time zone: the same moment is a different local time in New York', () => {
    process.env.TZ = 'America/New_York';
    try {
      const days = groupSlots(departureSlots(NOW));
      // 09:58Z is 05:58 in New York, so the first step, 10:05Z, is 06:05.
      expect(days[0]?.hours[0]?.hour).toBe(6);
      expect(days[0]?.hours[0]?.minutes[0]?.minute).toBe(5);
      expect(localDayKey(NOW)).toBe('2026-09-20');
    } finally {
      process.env.TZ = 'Europe/London';
    }
  });

  it('names a local day by the device zone, not by UTC', () => {
    const lateEvening = Date.parse('2026-09-20T23:30:00Z'); // 00:30 the next day in London
    expect(localDayKey(lateEvening)).toBe('2026-09-21');
    process.env.TZ = 'America/Los_Angeles';
    try {
      expect(localDayKey(lateEvening)).toBe('2026-09-20');
    } finally {
      process.env.TZ = 'Europe/London';
    }
  });

  it('leaves out the hour that does not exist when the clocks go forward', () => {
    // London, Sunday 29 March 2026: 01:00 GMT becomes 02:00 BST, so there is no 01:xx.
    const start = Date.parse('2026-03-29T00:00:00Z');
    const day = groupSlots(listSlots(start, start + 4 * 60 * MINUTE_MS))[0];
    // Midnight to 04:00 UTC is 00:00 to 05:00 local, and the hour from 01:00 to 02:00 is missing.
    expect(day?.hours.map((hour) => hour.hour)).toEqual([0, 2, 3, 4, 5]);
  });

  it('offers the hour that happens twice when the clocks go back only once', () => {
    // London, Sunday 25 October 2026: 02:00 BST becomes 01:00 GMT, so 01:xx happens twice.
    // Local midnight on the 25th is 23:00 UTC on the 24th (still summer time).
    const start = Date.parse('2026-10-24T23:00:00Z');
    const day = groupSlots(listSlots(start, start + 5 * 60 * MINUTE_MS))[0];
    const hours = day?.hours.map((hour) => hour.hour);
    expect(hours).toEqual([0, 1, 2, 3, 4]);
    const repeated = day?.hours.find((hour) => hour.hour === 1);
    expect(repeated?.minutes).toHaveLength(12);
    // Each minute is the first time it happens (00:xx BST is 23:xx UTC; the first 01:00 is 00:00Z).
    expect(new Date(repeated?.minutes[0]?.at ?? 0).toISOString()).toBe('2026-10-25T00:00:00.000Z');
  });
});

describe('choosing another day or hour', () => {
  const days = groupSlots(departureSlots(NOW));
  const tomorrow = days[1];
  const at = (iso: string) => Date.parse(iso);

  it('keeps the time of day on another day when it can', () => {
    if (!tomorrow) throw new Error('no second day');
    // 13:35 London today is 12:35Z; tomorrow at the same clock time is 12:35Z the next day.
    const chosen = timeOnDay(tomorrow, at('2026-09-20T12:35:00Z'));
    expect(new Date(chosen).toISOString()).toBe('2026-09-21T12:35:00.000Z');
    expect(minuteOfDay(chosen)).toBe(minuteOfDay(at('2026-09-20T12:35:00Z')));
  });

  it('takes the first time of the day when there is no time to keep', () => {
    if (!tomorrow) throw new Error('no second day');
    expect(new Date(timeOnDay(tomorrow, null)).toISOString()).toBe('2026-09-20T23:00:00.000Z');
  });

  it('takes the nearest time on the last, shorter day', () => {
    const last = days.at(-1);
    if (!last) throw new Error('no last day');
    // The last day stops at 10:55 London; 13:35 is beyond it, so the nearest is its last time.
    const chosen = timeOnDay(last, at('2026-09-20T12:35:00Z'));
    expect(new Date(chosen).toISOString()).toBe('2026-09-27T09:55:00.000Z');
  });

  it('keeps the minute in another hour, or takes the nearest one', () => {
    const today = days[0];
    const first = today?.hours[0];
    if (!first) throw new Error('no first hour');
    // Today's first hour has no :00, so 12:00 asks for the nearest minute, :05.
    const chosen = timeInHour(first, at('2026-09-20T11:00:00Z'));
    expect(new Date(chosen).toISOString()).toBe('2026-09-20T10:05:00.000Z');
    const second = today?.hours[1];
    if (!second) throw new Error('no second hour');
    expect(new Date(timeInHour(second, at('2026-09-20T10:35:00Z'))).toISOString()).toBe(
      '2026-09-20T11:35:00.000Z',
    );
  });
});
