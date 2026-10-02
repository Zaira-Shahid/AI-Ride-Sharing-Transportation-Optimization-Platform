import type { SetUserStatusResult, UserStatus } from '@ridemesh/types';
import {
  collection,
  documentId,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter,
  where,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { AuthFlowError, getErrorCode } from './auth-errors';
import type { FirebaseClient } from './client';
import {
  ADMIN_LIST_PAGE_SIZE,
  sliceStatusPage,
  type Page,
  type PageOptions,
  type StatusCursor,
} from './paging';

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
 * One page of passenger accounts, suspended ones first (the actionable queue): the database orders by
 * `status` DESCENDING then document id descending (SUSPENDED sorts after ACTIVE, so descending puts it
 * first), which needs the `users` index on `role` and `status` in firestore.indexes.json. Phase 14
 * (performance): a page of 50 with a cursor instead of every passenger. Firestore rules already let any
 * staff role read every `users` document in full, so this is a direct client query, not a callable -
 * the same shape as listDriversForReview.
 */
export async function listPassengersForReview(
  client: Pick<FirebaseClient, 'firestore'>,
  options: PageOptions<StatusCursor> = {},
): Promise<Page<PassengerRow, StatusCursor>> {
  const pageSize = options.pageSize ?? ADMIN_LIST_PAGE_SIZE;
  const fetched = (
    await getDocs(
      query(
        collection(client.firestore, 'users'),
        where('role', '==', 'PASSENGER'),
        orderBy('status', 'desc'),
        orderBy(documentId(), 'desc'),
        ...(options.cursor ? [startAfter(options.cursor.status, options.cursor.id)] : []),
        limit(pageSize + 1),
      ),
    )
  ).docs;
  const { docs: passengerDocs, nextCursor } = sliceStatusPage(fetched, pageSize, 'status');

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

  return { rows, nextCursor };
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
