import type {
  DriverAvailabilityStatus,
  SetAvailabilityInput,
  SetAvailabilityResult,
} from '@ridemesh/types';
import { httpsCallable } from 'firebase/functions';
import { AuthFlowError, getErrorCode } from './auth-errors';
import type { FirebaseClient } from './client';

/**
 * Goes online or offline through the setAvailability function. The server decides: going online
 * needs a verified driver and vehicle with seats set, and going offline always works.
 */
export async function setAvailability(
  client: Pick<FirebaseClient, 'functions'>,
  status: DriverAvailabilityStatus,
): Promise<SetAvailabilityResult['status']> {
  try {
    const result = await httpsCallable<SetAvailabilityInput, SetAvailabilityResult>(
      client.functions,
      'setAvailability',
    )({ status });
    return result.data.status;
  } catch (error) {
    if (getErrorCode(error) === 'functions/failed-precondition') {
      throw new AuthFlowError(
        'permission',
        'You cannot go online yet. Check the list below and try again.',
      );
    }
    throw error;
  }
}
