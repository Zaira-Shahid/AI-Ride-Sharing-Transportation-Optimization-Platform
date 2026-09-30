import type { AnalyticsSummary } from '@ridemesh/types';
import { httpsCallable } from 'firebase/functions';
import { AuthFlowError, getErrorCode } from './auth-errors';
import type { FirebaseClient } from './client';

// Module 12 (Analytics). Platform-wide totals are never readable by clients directly; this wraps the
// one callable any staff role reads them through.

export async function getAnalyticsSummary(
  client: Pick<FirebaseClient, 'functions'>,
): Promise<AnalyticsSummary> {
  try {
    const result = await httpsCallable<undefined, AnalyticsSummary>(
      client.functions,
      'getAnalyticsSummary',
    )();
    return result.data;
  } catch (error) {
    if (getErrorCode(error) === 'functions/permission-denied') {
      throw new AuthFlowError('permission', 'You are not allowed to view analytics.');
    }
    throw error;
  }
}
