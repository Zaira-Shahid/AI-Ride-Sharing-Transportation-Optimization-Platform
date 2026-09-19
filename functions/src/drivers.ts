import {
  FieldValue,
  type DocumentReference,
  type Firestore,
  type Transaction,
} from 'firebase-admin/firestore';

// Mirrors NEW_DRIVER_PROFILE_DEFAULTS in @ridemesh/types (functions cannot import workspace
// packages). tests/roles-parity.test.ts fails if the two diverge.
export const NEW_DRIVER_PROFILE_DEFAULTS = {
  verificationStatus: 'PENDING',
  verificationReason: null,
  verificationReviewedAt: null,
  availabilityStatus: 'OFFLINE',
  rating: null,
  totalTrips: 0,
  maxDetourMinutes: null,
  maxDetourDistance: null,
  automaticMatchingEnabled: null,
} as const;

/**
 * Queues the creation of drivers/{uid} and its audit entry in a transaction. The caller checks
 * that the document does not exist yet (tx.create also fails if it does). The uid is the document
 * ID, so a driver can only ever have one profile.
 */
export function createDriverProfile(
  tx: Transaction,
  driverRef: DocumentReference,
  auditRef: DocumentReference,
  uid: string,
  actor: string,
  reason: string,
): void {
  tx.create(driverRef, {
    userId: uid,
    ...NEW_DRIVER_PROFILE_DEFAULTS,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  tx.create(auditRef, {
    timestamp: FieldValue.serverTimestamp(),
    actor,
    action: 'DRIVER_PROFILE_CREATED',
    entity: `drivers/${uid}`,
    previousState: null,
    newState: { verificationStatus: NEW_DRIVER_PROFILE_DEFAULTS.verificationStatus },
    reason,
  });
}

export interface DriverBackfillResult {
  drivers: number;
  created: number;
}

/**
 * Gives every driver account that registered before Module 2.1 a driver profile. Safe to run
 * repeatedly: an existing profile is left untouched. Only ever called from the service-account
 * script (scripts/backfill-driver-profiles.mjs); no client-callable function exposes it.
 */
export async function backfillDriverProfiles(deps: {
  firestore: Firestore;
}): Promise<DriverBackfillResult> {
  const drivers = await deps.firestore.collection('users').where('role', '==', 'DRIVER').get();
  let created = 0;
  for (const user of drivers.docs) {
    const driverRef = deps.firestore.collection('drivers').doc(user.id);
    const wasCreated = await deps.firestore.runTransaction(async (tx) => {
      if ((await tx.get(driverRef)).exists) return false;
      createDriverProfile(
        tx,
        driverRef,
        deps.firestore.collection('auditLogs').doc(),
        user.id,
        'script:backfill-driver-profiles',
        'Driver profile created for an account registered before driver profiles existed',
      );
      return true;
    });
    if (wasCreated) created += 1;
  }
  return { drivers: drivers.size, created };
}
