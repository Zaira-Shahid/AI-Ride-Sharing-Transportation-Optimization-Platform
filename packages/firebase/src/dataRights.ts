import {
  DELETE_ACCOUNT_CONFIRMATION,
  type DeleteMyAccountResult,
  type PersonalDataExport,
} from '@ridemesh/types';
import { httpsCallable } from 'firebase/functions';
import type { FirebaseClient } from './client';

// Phase 14 (Privacy compliance): the rider's own side of functions/src/dataRights.ts (passenger) and
// driverDataRights.ts (driver). A refusal (an open ride, being online, an outstanding payment, an
// unresolved dispute, Stripe unreachable) arrives as a functions error whose message is already
// written for the person to read.

/**
 * Everything the signed-in passenger or driver gave or was given, as one object the app can save or
 * share as JSON. The server picks the right export for the caller's role.
 */
export async function exportMyData(
  client: Pick<FirebaseClient, 'functions'>,
): Promise<PersonalDataExport> {
  const result = await httpsCallable<Record<string, never>, PersonalDataExport>(
    client.functions,
    'exportMyData',
  )({});
  return result.data;
}

/**
 * Permanently deletes the signed-in passenger's or driver's account (see functions/src/dataRights.ts
 * and driverDataRights.ts for what is removed and what is anonymized and kept). The caller's
 * session ends because the account no longer exists; the app should treat a successful result as
 * signed out.
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
