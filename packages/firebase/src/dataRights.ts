import {
  DELETE_ACCOUNT_CONFIRMATION,
  type DeleteMyAccountResult,
  type PassengerDataExport,
} from '@ridemesh/types';
import { httpsCallable } from 'firebase/functions';
import type { FirebaseClient } from './client';

// Phase 14 (Privacy compliance): the passenger's own side of functions/src/dataRights.ts. A refusal
// (an open ride, an outstanding payment, an unresolved dispute, Stripe unreachable) arrives as a
// functions error whose message is already written for the passenger to read.

/** Everything the passenger gave or was given, as one object the app can save or share as JSON. */
export async function exportMyData(
  client: Pick<FirebaseClient, 'functions'>,
): Promise<PassengerDataExport> {
  const result = await httpsCallable<Record<string, never>, PassengerDataExport>(
    client.functions,
    'exportMyData',
  )({});
  return result.data;
}

/**
 * Permanently deletes the signed-in passenger's account (see functions/src/dataRights.ts for what is
 * removed and what is anonymized and kept). The caller's session ends because the account no longer
 * exists; the app should treat a successful result as signed out.
 */
export async function deleteMyAccount(
  client: Pick<FirebaseClient, 'functions'>,
): Promise<DeleteMyAccountResult['status']> {
  const result = await httpsCallable<{ confirm: string }, DeleteMyAccountResult>(
    client.functions,
    'deleteMyAccount',
  )({ confirm: DELETE_ACCOUNT_CONFIRMATION });
  return result.data.status;
}
