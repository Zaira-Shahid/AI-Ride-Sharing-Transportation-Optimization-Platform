import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import {
  auditTakenOffline,
  journeyOfflineFields,
  offlineFields,
  readOwnJourney,
} from './availability.js';
import { requireVerifiedDriver, type DriverCaller } from './callers.js';

// Functions deploy from this directory alone, so these mirror @ridemesh/types.
// tests/roles-parity.test.ts fails if they diverge.
export const REVIEWER_ROLES = ['ADMIN', 'SUPER_ADMIN'] as const;
export const REVIEW_DECISIONS = ['VERIFIED', 'REJECTED'] as const;
export const REVIEW_TARGETS = ['DRIVER', 'VEHICLE'] as const;
export const REVIEW_REASON_MAX_LENGTH = 500;

export const reviewInputSchema = z
  .object({
    // A Firebase uid: no slashes or dots, so it cannot point at another path.
    driverId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{1,128}$/),
    decision: z.enum(REVIEW_DECISIONS),
    // null is accepted because the Firebase SDK sends an omitted field as null.
    reason: z.string().trim().max(REVIEW_REASON_MAX_LENGTH).nullish(),
  })
  .refine((input) => input.decision !== 'REJECTED' || (input.reason ?? '').length > 0, {
    path: ['reason'],
    message: 'A rejection needs a reason.',
  });

export const requestReviewInputSchema = z.object({ target: z.enum(REVIEW_TARGETS) });

export type ReviewTarget = (typeof REVIEW_TARGETS)[number];
export type ReviewResult = { status: 'reviewed' | 'unchanged' };
export type RequestReviewResult = { status: 'requested' | 'unchanged' };

const COLLECTIONS = { DRIVER: 'drivers', VEHICLE: 'vehicles' } as const;

export interface StaffCaller {
  uid: string;
  role: unknown;
  emailVerified: boolean;
}

/** Records a staff decision on a driver or a vehicle. `actor` is the staff uid or a script name. */
export async function reviewVerification(
  deps: { firestore: Firestore },
  target: ReviewTarget,
  actor: string,
  rawInput: unknown,
): Promise<ReviewResult> {
  const parsed = reviewInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'The review is not valid.');
  }
  const { driverId, decision } = parsed.data;
  const reason = decision === 'REJECTED' ? (parsed.data.reason ?? null) : null;

  const { firestore } = deps;
  const collection = COLLECTIONS[target];
  const ref = firestore.collection(collection).doc(driverId);
  const driverRef = firestore.collection('drivers').doc(driverId);

  return firestore.runTransaction(async (tx): Promise<ReviewResult> => {
    const [snapshot, driverSnapshot] = await Promise.all([tx.get(ref), tx.get(driverRef)]);
    // Read now (Module 5.1): all of a transaction's reads must happen before any of its writes.
    const ownJourney = await readOwnJourney(tx, firestore, driverId, driverSnapshot);
    if (!snapshot.exists) {
      throw new HttpsError('not-found', `There is no ${target.toLowerCase()} with that ID.`);
    }

    const previousStatus: unknown = snapshot.get('verificationStatus');
    const previousReason: unknown = snapshot.get('verificationReason') ?? null;
    if (previousStatus === decision && previousReason === reason) return { status: 'unchanged' };

    // A driver who loses their verification, or whose vehicle does, cannot stay online.
    const offline = decision === 'REJECTED' ? offlineFields(driverSnapshot) : undefined;
    tx.update(ref, {
      verificationStatus: decision,
      verificationReason: reason,
      verificationReviewedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      ...(target === 'DRIVER' ? offline : undefined),
    });
    if (offline) {
      if (target === 'VEHICLE') tx.update(driverRef, offline);
      const journeyOffline = journeyOfflineFields(ownJourney);
      if (journeyOffline && ownJourney) {
        tx.update(ownJourney.ref, { ...journeyOffline, updatedAt: FieldValue.serverTimestamp() });
      }
      auditTakenOffline(
        tx,
        firestore,
        driverId,
        actor,
        `The ${target.toLowerCase()} is no longer verified`,
      );
    }
    tx.create(firestore.collection('auditLogs').doc(), {
      timestamp: FieldValue.serverTimestamp(),
      actor,
      action: `${target}_VERIFICATION_REVIEWED`,
      entity: `${collection}/${driverId}`,
      previousState: {
        verificationStatus: previousStatus ?? null,
        verificationReason: previousReason,
      },
      newState: { verificationStatus: decision, verificationReason: reason },
      reason: reason ?? 'Staff verified',
    });
    return { status: 'reviewed' };
  });
}

/**
 * Lets verified ADMIN and SUPER_ADMIN staff verify or reject a driver or a vehicle. The role comes
 * from the signed token (a custom claim only server code can set), never from a document.
 */
export function reviewAsStaff(
  deps: { firestore: Firestore },
  target: ReviewTarget,
  caller: StaffCaller,
  rawInput: unknown,
): Promise<ReviewResult> {
  const allowed = (REVIEWER_ROLES as readonly unknown[]).includes(caller.role);
  if (!allowed || !caller.emailVerified) {
    throw new HttpsError('permission-denied', 'You are not allowed to review drivers.');
  }
  return reviewVerification(deps, target, caller.uid, rawInput);
}

/**
 * Lets a driver ask for a rejected driver profile or vehicle to be looked at again. Only a REJECTED
 * status moves (back to PENDING, the reason cleared); anything else is left as it is. The driver
 * can never set VERIFIED themselves.
 */
export async function requestReview(
  deps: { firestore: Firestore },
  caller: DriverCaller,
  rawInput: unknown,
): Promise<RequestReviewResult> {
  requireVerifiedDriver(caller);

  const parsed = requestReviewInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'The request is not valid.');
  }
  const { target } = parsed.data;

  const { firestore } = deps;
  const collection = COLLECTIONS[target];
  const ref = firestore.collection(collection).doc(caller.uid);
  const userRef = firestore.collection('users').doc(caller.uid);

  return firestore.runTransaction(async (tx): Promise<RequestReviewResult> => {
    const [user, snapshot] = await Promise.all([tx.get(userRef), tx.get(ref)]);
    if (!user.exists || user.get('status') !== 'ACTIVE' || !snapshot.exists) {
      throw new HttpsError(
        'failed-precondition',
        'This account cannot ask for a review right now.',
      );
    }
    if (snapshot.get('verificationStatus') !== 'REJECTED') return { status: 'unchanged' };

    const previousReason: unknown = snapshot.get('verificationReason') ?? null;
    tx.update(ref, {
      verificationStatus: 'PENDING',
      verificationReason: null,
      verificationReviewedAt: null,
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.create(firestore.collection('auditLogs').doc(), {
      timestamp: FieldValue.serverTimestamp(),
      actor: caller.uid,
      action: `${target}_REVIEW_REQUESTED`,
      entity: `${collection}/${caller.uid}`,
      previousState: { verificationStatus: 'REJECTED', verificationReason: previousReason },
      newState: { verificationStatus: 'PENDING', verificationReason: null },
      reason: 'Driver asked for a new review',
    });
    return { status: 'requested' };
  });
}
