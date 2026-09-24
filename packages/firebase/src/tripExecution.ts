import type { AdvanceTripInput, AdvanceTripResult, TripExecutionRefusal } from '@ridemesh/types';
import { httpsCallable } from 'firebase/functions';
import { AuthFlowError, type AuthErrorKind } from './auth-errors';
import type { FirebaseClient } from './client';

const REFUSAL_MESSAGES: Record<TripExecutionRefusal, { kind: AuthErrorKind; message: string }> = {
  INVALID: { kind: 'validation', message: 'That request is not valid.' },
  NOT_FOUND: { kind: 'validation', message: 'That ride request was not found.' },
  WRONG_STATUS: { kind: 'permission', message: 'This step cannot be done right now.' },
};

function explainRefusal(error: unknown): unknown {
  const reason = (error as { details?: { reason?: unknown } } | null)?.details?.reason;
  if (typeof reason !== 'string' || !(reason in REFUSAL_MESSAGES)) return error;
  const { kind, message } = REFUSAL_MESSAGES[reason as TripExecutionRefusal];
  return new AuthFlowError(kind, message);
}

/** The signed-in driver starts toward tripId's pickup point (Module 7.2). Manual, driver-initiated. */
export async function headToPickup(
  client: Pick<FirebaseClient, 'functions'>,
  tripId: string,
): Promise<AdvanceTripResult['status']> {
  try {
    const result = await httpsCallable<AdvanceTripInput, AdvanceTripResult>(
      client.functions,
      'headToPickup',
    )({ tripId });
    return result.data.status;
  } catch (error) {
    throw explainRefusal(error);
  }
}

/** The signed-in driver confirms tripId's passenger is now in the vehicle (Module 7.2). */
export async function confirmPickup(
  client: Pick<FirebaseClient, 'functions'>,
  tripId: string,
): Promise<AdvanceTripResult['status']> {
  try {
    const result = await httpsCallable<AdvanceTripInput, AdvanceTripResult>(
      client.functions,
      'confirmPickup',
    )({ tripId });
    return result.data.status;
  } catch (error) {
    throw explainRefusal(error);
  }
}

/** The signed-in driver confirms they are now driving with tripId's passenger aboard (Module 7.4). */
export async function startTransit(
  client: Pick<FirebaseClient, 'functions'>,
  tripId: string,
): Promise<AdvanceTripResult['status']> {
  try {
    const result = await httpsCallable<AdvanceTripInput, AdvanceTripResult>(
      client.functions,
      'startTransit',
    )({ tripId });
    return result.data.status;
  } catch (error) {
    throw explainRefusal(error);
  }
}
