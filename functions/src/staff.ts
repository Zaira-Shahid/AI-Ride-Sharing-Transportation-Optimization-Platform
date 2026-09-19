import { FieldValue } from 'firebase-admin/firestore';
import { isStaffRole, type StaffRole } from './roles.js';
import type { RoleDeps } from './registration.js';

export interface StaffRoleResult {
  uid: string;
  previousRole: string | null;
  role: StaffRole;
  emailVerified: boolean;
}

/**
 * Assigns a staff role to an existing account. Only ever called from the service-account script
 * (scripts/set-staff-role.mjs); no client-callable function exposes it.
 */
export async function assignStaffRole(
  deps: RoleDeps,
  email: string,
  role: unknown,
): Promise<StaffRoleResult> {
  if (!isStaffRole(role)) {
    throw new Error('Role must be one of SUPPORT, OPERATIONS, ADMIN, SUPER_ADMIN.');
  }

  const user = await deps.auth.getUserByEmail(email);
  const previousRole =
    typeof user.customClaims?.role === 'string' ? (user.customClaims.role as string) : null;

  await deps.auth.setCustomUserClaims(user.uid, { ...user.customClaims, role });
  await deps.auth.revokeRefreshTokens(user.uid);

  const profileRef = deps.firestore.collection('users').doc(user.uid);
  const auditRef = deps.firestore.collection('auditLogs').doc();
  await deps.firestore.runTransaction(async (tx) => {
    const snapshot = await tx.get(profileRef);
    if (snapshot.exists) {
      tx.update(profileRef, { role, updatedAt: FieldValue.serverTimestamp() });
    } else {
      tx.create(profileRef, {
        role,
        name: user.displayName ?? email,
        email,
        phone: null,
        photoUrl: user.photoURL ?? null,
        status: 'ACTIVE',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    tx.create(auditRef, {
      timestamp: FieldValue.serverTimestamp(),
      actor: 'script:set-staff-role',
      action: 'ROLE_ASSIGNED',
      entity: `users/${user.uid}`,
      previousState: { role: previousRole },
      newState: { role },
      reason: 'Staff role assigned by service-account script',
    });
  });

  return { uid: user.uid, previousRole, role, emailVerified: user.emailVerified };
}
