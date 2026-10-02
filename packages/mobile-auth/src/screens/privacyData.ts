import { getErrorCode } from '@ridemesh/firebase';
import { DELETE_ACCOUNT_CONFIRMATION, type PassengerDataExport } from '@ridemesh/types';

// Phase 14 (Privacy compliance): the parts of the passenger's "Privacy and data" section that need no
// React Native, so they can be unit tested. The screen itself is PrivacySection.tsx.

export const EXPORT_FAILED = 'We could not prepare your data. Please try again.';
export const DELETE_FAILED = 'We could not delete your account. Please try again.';

// The server writes these refusals for the passenger to read ("Finish or cancel your current ride
// before deleting your account.", a pending payment, an open dispute, too many tries), so they are
// shown as they are. Anything else (offline, a crash, a code the server never sends) gets the generic
// line: a raw error string is no help to the passenger.
const READABLE_REFUSALS = new Set([
  'functions/failed-precondition',
  'functions/unavailable',
  'functions/resource-exhausted',
]);

export function describeDataRightsError(error: unknown, fallback: string): string {
  const code = getErrorCode(error);
  if (code && READABLE_REFUSALS.has(code) && error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

/** The export as the file the passenger keeps: readable, indented JSON. */
export function exportJson(data: PassengerDataExport): string {
  return JSON.stringify(data, null, 2);
}

/** `ridemesh-my-data-2026-10-02.json`, from the export's own timestamp so the name matches its content. */
export function exportFileName(exportedAt: string): string {
  const day = /^\d{4}-\d{2}-\d{2}/.exec(exportedAt)?.[0] ?? 'export';
  return `ridemesh-my-data-${day}.json`;
}

/** Whether what the passenger typed is exactly the word the server requires (case matters). */
export function isDeleteConfirmed(typed: string): boolean {
  return typed.trim() === DELETE_ACCOUNT_CONFIRMATION;
}

/** What the section tells the passenger about keeping and removing data, in plain language. */
export const PRIVACY_NOTES = [
  'You can download a copy of your details, rides, receipts and notifications.',
  'The exact pickup and destination of a ride are removed 30 days after the ride ends.',
  'If you delete your account, your profile, saved card and notifications are removed and your past rides are no longer linked to you.',
  'Fare and payment records are kept without your name, because payment records have to be kept.',
  'We also keep a log that an action happened. It holds an account ID, never your name or email.',
] as const;
