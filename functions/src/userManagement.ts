import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { USER_STATUSES } from './roles.js';
import { REVIEWER_ROLES, type StaffCaller } from './verification.js';

// Module 11.3 (admin dashboard: user management). See packages/types/src/userManagement.ts's own
// comment for the spec-check that scoped this to passenger accounts only.

export const SET_USER_STATUS_REASON_MAX_LENGTH = 500;

export const setUserStatusInputSchema = z
  .object({
    userId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{1,128}$/),
    status: z.enum(USER_STATUSES),
    reason: z.string().trim().max(SET_USER_STATUS_REASON_MAX_LENGTH).nullish(),
  })
  .refine((input) => input.status !== 'SUSPENDED' || (input.reason ?? '').length > 0, {
    path: ['reason'],
    message: 'A suspension needs a reason.',
  });

export type SetUserStatusResult = { status: 'changed' | 'unchanged' };

/** Records a staff decision to suspend or reinstate a passenger's account. */
export async function setUserStatus(
  deps: { firestore: Firestore },
  actor: string,
  rawInput: unknown,
): Promise<SetUserStatusResult> {
  const parsed = setUserStatusInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'The request is not valid.');
  }
  const { userId, status } = parsed.data;
  const reason = status === 'SUSPENDED' ? (parsed.data.reason ?? null) : null;

  const { firestore } = deps;
  const ref = firestore.collection('users').doc(userId);

  return firestore.runTransaction(async (tx): Promise<SetUserStatusResult> => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) {
      throw new HttpsError('not-found', 'There is no account with that ID.');
    }
    // Drivers keep their own verification-driven offline lifecycle (verification.ts); staff accounts
    // are managed by the service-account script, never through this console action.
    if (snapshot.get('role') !== 'PASSENGER') {
      throw new HttpsError('failed-precondition', 'Only passenger accounts can be managed here.');
    }

    const previousStatus: unknown = snapshot.get('status');
    const previousReason: unknown = snapshot.get('statusReason') ?? null;
    if (previousStatus === status && previousReason === reason) return { status: 'unchanged' };

    tx.update(ref, {
      status,
      statusReason: reason,
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.create(firestore.collection('auditLogs').doc(), {
      timestamp: FieldValue.serverTimestamp(),
      actor,
      action: 'USER_STATUS_CHANGED',
      entity: `users/${userId}`,
      previousState: { status: previousStatus ?? null, statusReason: previousReason },
      newState: { status, statusReason: reason },
      reason: reason ?? 'Staff reinstated the account',
    });
    return { status: 'changed' };
  });
}

/**
 * Lets verified ADMIN and SUPER_ADMIN staff suspend or reinstate a passenger account - the same
 * REVIEWER_ROLES restriction reviewAsStaff (verification.ts) already uses for driver/vehicle
 * decisions. SUPPORT/OPERATIONS can see the queue but not act on it.
 */
export function setUserStatusAsStaff(
  deps: { firestore: Firestore },
  caller: StaffCaller,
  rawInput: unknown,
): Promise<SetUserStatusResult> {
  const allowed = (REVIEWER_ROLES as readonly unknown[]).includes(caller.role);
  if (!allowed || !caller.emailVerified) {
    throw new HttpsError('permission-denied', 'You are not allowed to manage user accounts.');
  }
  return setUserStatus(deps, caller.uid, rawInput);
}
