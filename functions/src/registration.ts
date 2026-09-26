import type { Auth } from 'firebase-admin/auth';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { createDriverProfile } from './drivers.js';
import { SELF_SERVICE_ROLES, type SelfServiceRole } from './roles.js';

export const completeRegistrationInputSchema = z.object({
  role: z.enum(SELF_SERVICE_ROLES),
  name: z.string().trim().min(1).max(100),
  phone: z.string().trim().min(1).max(32).optional(),
});

export interface RoleDeps {
  auth: Auth;
  firestore: Firestore;
}

/**
 * Assigns the caller their self-selected role and creates their profile.
 *
 * The role is written as a custom claim, which only server code can set. A role, once assigned,
 * can never be changed through this path, so it cannot be used to escalate or switch roles.
 * Calling it again with the same role is safe and repairs a half-completed earlier attempt.
 */
export async function registerUser(
  deps: RoleDeps,
  uid: string,
  rawInput: unknown,
): Promise<{ role: SelfServiceRole }> {
  const parsed = completeRegistrationInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'The registration details are not valid.');
  }
  const input = parsed.data;

  const user = await deps.auth.getUser(uid);
  if (!user.email) {
    throw new HttpsError('failed-precondition', 'An email address is required to register.');
  }

  const existingRole: unknown = user.customClaims?.role;
  if (existingRole !== undefined && existingRole !== input.role) {
    throw new HttpsError('failed-precondition', 'This account already has a role.');
  }

  const profileRef = deps.firestore.collection('users').doc(uid);
  const driverRef = deps.firestore.collection('drivers').doc(uid);
  await deps.firestore.runTransaction(async (tx) => {
    const snapshot = await tx.get(profileRef);
    const driverSnapshot = input.role === 'DRIVER' ? await tx.get(driverRef) : undefined;
    const needsDriverProfile = driverSnapshot !== undefined && !driverSnapshot.exists;

    if (snapshot.exists) {
      if (snapshot.get('role') !== input.role) {
        throw new HttpsError('failed-precondition', 'This account already has a role.');
      }
      // A repeat call also repairs a driver whose driver profile is missing.
      if (needsDriverProfile) {
        createDriverProfile(
          tx,
          driverRef,
          deps.firestore.collection('auditLogs').doc(),
          uid,
          uid,
          'Driver profile created on repeat registration',
        );
      }
      return;
    }

    tx.create(profileRef, {
      role: input.role,
      name: input.name,
      email: user.email,
      phone: input.phone ?? null,
      photoUrl: user.photoURL ?? null,
      status: 'ACTIVE',
      // An Expo push token (Module 10.2); null until the app saves one via savePushToken.
      pushToken: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.create(deps.firestore.collection('auditLogs').doc(), {
      timestamp: FieldValue.serverTimestamp(),
      actor: uid,
      action: 'ROLE_ASSIGNED',
      entity: `users/${uid}`,
      previousState: null,
      newState: { role: input.role },
      reason: 'Self-service registration',
    });
    if (needsDriverProfile) {
      createDriverProfile(
        tx,
        driverRef,
        deps.firestore.collection('auditLogs').doc(),
        uid,
        uid,
        'Self-service driver registration',
      );
    }
  });

  if (existingRole !== input.role) {
    await deps.auth.setCustomUserClaims(uid, { ...user.customClaims, role: input.role });
  }

  return { role: input.role };
}
