import type { SetUserStatusResult, UserStatus } from '@ridemesh/types';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { AuthFlowError, getErrorCode } from './auth-errors';
import type { FirebaseClient } from './client';

// Module 11.3 (admin dashboard: user management): the staff side of suspending/reinstating a
// passenger account (functions/src/userManagement.ts's setUserStatus) - see that file's own comment
// for the spec-check that scoped this to passengers only. Same "a one-shot fetch is enough for a
// staff work queue that always re-fetches after every decision" stance as adminReview.ts's own
// listDriversForReview.

export interface PassengerRow {
  uid: string;
  name: string;
  email: string;
  status: UserStatus;
  statusReason: string | null;
}

function isUserStatus(value: unknown): value is UserStatus {
  return value === 'ACTIVE' || value === 'SUSPENDED';
}

/**
 * Every passenger account, suspended ones first (the actionable queue). Firestore rules already let
 * any staff role read every `users` document in full, so this is a direct client query, not a
 * callable - the same shape as listDriversForReview.
 */
export async function listPassengersForReview(
  client: Pick<FirebaseClient, 'firestore'>,
): Promise<PassengerRow[]> {
  const passengerDocs = (
    await getDocs(query(collection(client.firestore, 'users'), where('role', '==', 'PASSENGER')))
  ).docs;

  const rows = passengerDocs.map((userDoc): PassengerRow => {
    const uid = userDoc.id;
    const data = userDoc.data();
    return {
      uid,
      name: typeof data.name === 'string' ? data.name : uid,
      email: typeof data.email === 'string' ? data.email : '',
      status: isUserStatus(data.status) ? data.status : 'ACTIVE',
      statusReason: typeof data.statusReason === 'string' ? data.statusReason : null,
    };
  });

  const rank = (status: UserStatus) => (status === 'SUSPENDED' ? 0 : 1);
  return rows.sort((a, b) => rank(a.status) - rank(b.status));
}

/**
 * Records a staff decision to suspend or reinstate a passenger (functions/src/userManagement.ts's
 * setUserStatus, via the setUserStatus callable) - only ADMIN and SUPER_ADMIN are actually allowed
 * (REVIEWER_ROLES, same restriction as submitStaffReview), surfaced here as the same clear message.
 */
export async function submitUserStatus(
  client: Pick<FirebaseClient, 'functions'>,
  userId: string,
  status: UserStatus,
  reason: string | null,
): Promise<SetUserStatusResult['status']> {
  try {
    const result = await httpsCallable<
      { userId: string; status: UserStatus; reason: string | null },
      SetUserStatusResult
    >(
      client.functions,
      'setUserStatus',
    )({ userId, status, reason });
    return result.data.status;
  } catch (error) {
    if (getErrorCode(error) === 'functions/permission-denied') {
      throw new AuthFlowError('permission', 'You are not allowed to manage user accounts.');
    }
    throw error;
  }
}
