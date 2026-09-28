import type { ListAuditLogsInput, ListAuditLogsResult } from '@ridemesh/types';
import { httpsCallable } from 'firebase/functions';
import { AuthFlowError, getErrorCode } from './auth-errors';
import type { FirebaseClient } from './client';

// Module 11.8 (admin dashboard: audit logs). The audit log is never readable by clients directly;
// this wraps the one callable ADMIN/SUPER_ADMIN staff read it through.

/** One page of audit entries, newest first, optionally filtered by exact action and/or actor. */
export async function listAuditLogs(
  client: Pick<FirebaseClient, 'functions'>,
  input: ListAuditLogsInput = {},
): Promise<ListAuditLogsResult> {
  try {
    const result = await httpsCallable<ListAuditLogsInput, ListAuditLogsResult>(
      client.functions,
      'listAuditLogs',
    )(input);
    return result.data;
  } catch (error) {
    if (getErrorCode(error) === 'functions/permission-denied') {
      throw new AuthFlowError('permission', 'You are not allowed to view the audit log.');
    }
    throw error;
  }
}
