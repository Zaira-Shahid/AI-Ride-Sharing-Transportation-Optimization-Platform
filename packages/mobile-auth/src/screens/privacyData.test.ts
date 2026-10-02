import { describe, expect, it } from 'vitest';
import {
  DELETE_FAILED,
  describeDataRightsError,
  exportFileName,
  deleteDialogMessage,
  exportJson,
  isDeleteConfirmed,
  privacyNotes,
} from './privacyData';

const refusal = (code: string, message: string) => Object.assign(new Error(message), { code });

describe('describeDataRightsError', () => {
  it.each(['failed-precondition', 'unavailable', 'resource-exhausted'])(
    'shows the server own message for %s',
    (code) => {
      const error = refusal(`functions/${code}`, 'Finish or cancel your current ride first.');
      expect(describeDataRightsError(error, DELETE_FAILED)).toBe(
        'Finish or cancel your current ride first.',
      );
    },
  );

  it.each([
    ['a code the server never sends for a refusal', refusal('functions/internal', 'boom')],
    ['a permission error', refusal('functions/permission-denied', 'Only verified passengers.')],
    ['a network failure with no code', new Error('Network request failed')],
    ['something that is not an error', 'oops'],
  ])('falls back to the generic line for %s', (_label, error) => {
    expect(describeDataRightsError(error, DELETE_FAILED)).toBe(DELETE_FAILED);
  });

  it('falls back when a refusal carries an empty message', () => {
    expect(
      describeDataRightsError(refusal('functions/failed-precondition', ''), DELETE_FAILED),
    ).toBe(DELETE_FAILED);
  });
});

describe('isDeleteConfirmed', () => {
  it('accepts exactly DELETE, ignoring surrounding spaces', () => {
    expect(isDeleteConfirmed('DELETE')).toBe(true);
    expect(isDeleteConfirmed('  DELETE ')).toBe(true);
  });

  it.each(['', 'delete', 'Delete', 'DELET', 'DELETE ME', 'DELETED'])(
    'refuses %j: the server needs the exact word',
    (typed) => {
      expect(isDeleteConfirmed(typed)).toBe(false);
    },
  );
});

describe('export file', () => {
  it('names the file after the export day', () => {
    expect(exportFileName('2026-10-02T17:32:22.000Z')).toBe('ridemesh-my-data-2026-10-02.json');
  });

  it('still names a file when the timestamp is unreadable', () => {
    expect(exportFileName('not a date')).toBe('ridemesh-my-data-export.json');
  });

  it('writes indented JSON that parses back to the same data', () => {
    const data = {
      exportedAt: '2026-10-02T17:32:22.000Z',
      profile: {
        name: 'A',
        email: 'a@example.test',
        phone: null,
        status: 'ACTIVE',
        createdAt: null,
        hasSavedPaymentMethod: false,
      },
      trips: [],
      receipts: [],
      notifications: [],
      truncated: false,
    };
    const text = exportJson(data);
    expect(text).toContain('\n  "profile"');
    expect(JSON.parse(text)).toEqual(data);
  });
});

describe('what each app tells the person', () => {
  const text = (role: 'passenger' | 'driver') => privacyNotes(role).join(' ');

  it("tells a passenger about the 30 days and the saved card, and never about a driver's plate", () => {
    expect(text('passenger')).toMatch(/30 days/);
    expect(text('passenger')).toMatch(/saved card/);
    expect(text('passenger')).not.toMatch(/number plate|vehicle/i);
    expect(deleteDialogMessage('passenger')).toMatch(/saved card/);
  });

  it('tells a driver about the plate, the journeys and the earnings, and never about a saved card', () => {
    expect(text('driver')).toMatch(/number plate/);
    expect(text('driver')).toMatch(/journeys/);
    expect(text('driver')).toMatch(/earnings records are kept/);
    expect(text('driver')).toMatch(/online or a ride is in progress/);
    expect(text('driver')).not.toMatch(/saved card|30 days/);
    expect(deleteDialogMessage('driver')).toMatch(/vehicle/);
    expect(deleteDialogMessage('driver')).not.toMatch(/saved card/);
  });

  it.each(['passenger', 'driver'] as const)(
    'says for %s that it cannot be undone and that the log keeps an ID only',
    (role) => {
      expect(deleteDialogMessage(role)).toMatch(/cannot be undone/);
      expect(text(role)).toMatch(/account ID, never your name or email/);
    },
  );
});
