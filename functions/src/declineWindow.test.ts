import { Timestamp } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import { declineWindowMinutes, driverDecisionFor } from './declineWindow';

describe('declineWindowMinutes', () => {
  it.each([0, 1, 5, 15, 30])('keeps a valid window of %i minutes', (minutes) => {
    expect(declineWindowMinutes({ driverDeclineWindowMinutes: minutes })).toBe(minutes);
  });

  it.each([
    ['a missing setting', undefined],
    ['no settings object', null],
    ['an empty settings object', {}],
    ['a number', 7],
    ['a string', '10'],
    ['too long', { driverDeclineWindowMinutes: 31 }],
    ['negative', { driverDeclineWindowMinutes: -1 }],
    ['a fraction', { driverDeclineWindowMinutes: 2.5 }],
    ['not a number', { driverDeclineWindowMinutes: '10' }],
    ['null', { driverDeclineWindowMinutes: null }],
    ['not a finite number', { driverDeclineWindowMinutes: Number.NaN }],
  ])('uses the default for %s', (_name, settings) => {
    expect(declineWindowMinutes(settings)).toBe(5);
  });
});

describe('driverDecisionFor', () => {
  it('opens a window that ends at the deadline', () => {
    const decision = driverDecisionFor(1_000_000, 300_000);
    expect(decision.status).toBe('OPEN');
    expect(decision.deadline).toEqual(Timestamp.fromMillis(1_300_000));
  });

  it('makes a window of 0 final at once', () => {
    const decision = driverDecisionFor(1_000_000, 0);
    expect(decision.status).toBe('CONFIRMED');
    expect(decision.deadline).toEqual(Timestamp.fromMillis(1_000_000));
  });
});
