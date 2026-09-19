import type { RequestReviewInput, RequestReviewResult, ReviewTarget } from '@ridemesh/types';
import { httpsCallable } from 'firebase/functions';
import { AuthFlowError, getErrorCode } from './auth-errors';
import type { FirebaseClient } from './client';

/**
 * Asks for a rejected driver profile or vehicle to be looked at again. Only a rejected one moves
 * (back to pending); a driver can never verify themselves.
 */
export async function requestReview(
  client: Pick<FirebaseClient, 'functions'>,
  target: ReviewTarget,
): Promise<RequestReviewResult['status']> {
  try {
    const result = await httpsCallable<RequestReviewInput, RequestReviewResult>(
      client.functions,
      'requestReview',
    )({ target });
    return result.data.status;
  } catch (error) {
    if (getErrorCode(error) === 'functions/failed-precondition') {
      throw new AuthFlowError(
        'permission',
        'Your account cannot ask for a review right now. Please contact support.',
      );
    }
    throw error;
  }
}
