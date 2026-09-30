import type { OptimizationRunRow } from '@ridemesh/types';
import { httpsCallable } from 'firebase/functions';
import { AuthFlowError, getErrorCode } from './auth-errors';
import type { FirebaseClient } from './client';

// Module 11.9 (admin dashboard: optimization monitoring). optimizationRuns is never readable by
// clients directly; this wraps the one callable staff read it through.

/** Every optimization cycle, newest first, capped by a query-time retention limit. */
export async function listOptimizationRuns(
  client: Pick<FirebaseClient, 'functions'>,
): Promise<OptimizationRunRow[]> {
  try {
    const result = await httpsCallable<undefined, OptimizationRunRow[]>(
      client.functions,
      'listOptimizationRuns',
    )();
    return result.data;
  } catch (error) {
    if (getErrorCode(error) === 'functions/permission-denied') {
      throw new AuthFlowError('permission', 'You are not allowed to view optimization runs.');
    }
    throw error;
  }
}
