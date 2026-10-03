import type { OperationsSummary } from '@ridemesh/types';
import { httpsCallable } from 'firebase/functions';
import { AuthFlowError, getErrorCode } from './auth-errors';
import type { FirebaseClient } from './client';

// Phase 14 (Monitoring). The failure counters are never readable by clients directly; this wraps the
// one callable any staff role reads them through.

export async function getOperationsSummary(
  client: Pick<FirebaseClient, 'functions'>,
): Promise<OperationsSummary> {
  try {
    const result = await httpsCallable<undefined, OperationsSummary>(
      client.functions,
      'getOperationsSummary',
    )();
    return result.data;
  } catch (error) {
    if (getErrorCode(error) === 'functions/permission-denied') {
      throw new AuthFlowError('permission', 'You are not allowed to view operations.');
    }
    throw error;
  }
}
