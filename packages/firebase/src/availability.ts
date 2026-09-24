import type {
  DriverAvailabilityStatus,
  SetAvailabilityInput,
  SetAvailabilityRefusal,
  SetAvailabilityResult,
} from '@ridemesh/types';
import { httpsCallable } from 'firebase/functions';
import { AuthFlowError, getErrorCode } from './auth-errors';
import type { FirebaseClient } from './client';

function refusalReason(error: unknown): SetAvailabilityRefusal | null {
  const reason = (error as { details?: { reason?: unknown } } | null)?.details?.reason;
  return reason === 'PASSENGERS_ONBOARD' ? reason : null;
}

/**
 * Goes online or offline through the setAvailability function. The server decides: going online
 * needs a verified driver and vehicle with seats set. Going offline always works UNLESS a matched
 * passenger is already in the vehicle (Module 8.5, driver cancellation) - one only matched but not
 * yet picked up is released back to SEARCHING instead, not refused.
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
    if (refusalReason(error) === 'PASSENGERS_ONBOARD') {
      throw new AuthFlowError(
        'permission',
        'You have a passenger already in your vehicle. Complete their drop-off before going offline.',
      );
    }
    if (getErrorCode(error) === 'functions/failed-precondition') {
      throw new AuthFlowError(
        'permission',
        'You cannot go online yet. Check the list below and try again.',
      );
    }
    throw error;
  }
}
