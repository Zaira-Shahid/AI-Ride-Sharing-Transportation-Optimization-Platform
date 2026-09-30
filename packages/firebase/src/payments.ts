import type {
  ListPaymentsInput,
  ListPaymentsResult,
  PaymentsSummary,
  RefundPaymentInput,
  RefundPaymentResult,
} from '@ridemesh/types';
import { httpsCallable } from 'firebase/functions';
import { AuthFlowError, getErrorCode } from './auth-errors';
import type { FirebaseClient } from './client';

// Module 11.10 (admin dashboard: payments). tripRequests has no staff read rule (docs/security.md),
// so every one of these calls the corresponding functions/src/payments.ts callable.

function translate(error: unknown, message: string): never {
  if (getErrorCode(error) === 'functions/permission-denied') {
    throw new AuthFlowError('permission', message);
  }
  throw error;
}

/** One page of trips by payment status, newest first. */
export async function listPayments(
  client: Pick<FirebaseClient, 'functions'>,
  input: ListPaymentsInput = {},
): Promise<ListPaymentsResult> {
  try {
    const result = await httpsCallable<ListPaymentsInput, ListPaymentsResult>(
      client.functions,
      'listPayments',
    )(input);
    return result.data;
  } catch (error) {
    translate(error, 'You are not allowed to view payments.');
  }
}

/** Platform-wide totals only (captured, refunded, platform fee). */
export async function getPaymentsSummary(
  client: Pick<FirebaseClient, 'functions'>,
): Promise<PaymentsSummary> {
  try {
    const result = await httpsCallable<undefined, PaymentsSummary>(
      client.functions,
      'getPaymentsSummary',
    )();
    return result.data;
  } catch (error) {
    translate(error, 'You are not allowed to view payments.');
  }
}

/** Issues a refund on an already-captured payment. ADMIN/SUPER_ADMIN only. */
export async function refundPayment(
  client: Pick<FirebaseClient, 'functions'>,
  input: RefundPaymentInput,
): Promise<RefundPaymentResult['status']> {
  try {
    const result = await httpsCallable<RefundPaymentInput, RefundPaymentResult>(
      client.functions,
      'refundPayment',
    )(input);
    return result.data.status;
  } catch (error) {
    translate(error, 'You are not allowed to issue a refund.');
  }
}
