import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { enforceCallRateLimit } from './callLimits.js';
import { COMPANY_NAME_MAX, requireActiveCompanyAdmin, type CompanyCaller } from './companies.js';
import {
  DECLINE_WINDOW_MAX_MINUTES,
  DECLINE_WINDOW_MIN_MINUTES,
  declineWindowMinutes,
} from './declineWindow.js';

// What the company dashboard needs beyond the onboarding functions (module A4a,
// docs/a4-company-dashboard-design.md): change the company's settings, and count what the overview
// shows. Both are for an active administrator of the company, checked from the membership document.
// Nothing here reads a trip, a place or a location. The limits and schemas mirror @ridemesh/tenancy;
// tests/tenancy-parity.test.ts fails if they diverge.

export const SETTINGS_CHANGES_PER_ADMIN_PER_HOUR = 30;

const HOUR_MS = 3_600_000;

export const updateCompanySettingsInputSchema = z
  .object({
    name: z.string().trim().min(2).max(COMPANY_NAME_MAX).nullish(),
    driverDeclineWindowMinutes: z
      .number()
      .int()
      .min(DECLINE_WINDOW_MIN_MINUTES)
      .max(DECLINE_WINDOW_MAX_MINUTES)
      .nullish(),
  })
  // The Firebase client sends null for a field left undefined, so null means "leave it".
  .refine((value) => value.name != null || value.driverDeclineWindowMinutes != null);

export interface CompanyDashboardDeps {
  firestore: Firestore;
  now?: () => number;
}

function nowOf(deps: { now?: () => number }): number {
  return (deps.now ?? Date.now)();
}

/**
 * Changes the company's name and/or its driver decline window. Only what actually differs is
 * written and audited; asking for what is already set answers "unchanged" and writes nothing.
 */
export async function updateCompanySettings(
  deps: CompanyDashboardDeps,
  caller: CompanyCaller,
  rawInput: unknown,
): Promise<{
  status: 'updated' | 'unchanged';
  name: string;
  driverDeclineWindowMinutes: number;
}> {
  const { firestore } = deps;
  const companyId = await requireActiveCompanyAdmin(firestore, caller);
  const parsed = updateCompanySettingsInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new HttpsError(
      'invalid-argument',
      'The company name must be 2 to 100 characters and the decline window a whole number of minutes from 0 to 30.',
    );
  }
  const input = parsed.data;

  await enforceCallRateLimit(firestore, 'updateCompanySettings', caller.uid, nowOf(deps), {
    windowMs: HOUR_MS,
    maxCalls: SETTINGS_CHANGES_PER_ADMIN_PER_HOUR,
  });

  const ref = firestore.doc(`companies/${companyId}`);
  return firestore.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    const currentName = String(snapshot.get('name') ?? '');
    const currentWindow = declineWindowMinutes(snapshot.get('settings'));
    const nextName = input.name ?? currentName;
    const nextWindow = input.driverDeclineWindowMinutes ?? currentWindow;

    const nameChanged = nextName !== currentName;
    const windowChanged = nextWindow !== currentWindow;
    if (!nameChanged && !windowChanged) {
      return { status: 'unchanged', name: currentName, driverDeclineWindowMinutes: currentWindow };
    }

    tx.update(ref, {
      ...(nameChanged ? { name: nextName } : {}),
      ...(windowChanged ? { 'settings.driverDeclineWindowMinutes': nextWindow } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.create(firestore.collection('auditLogs').doc(), {
      timestamp: FieldValue.serverTimestamp(),
      actor: caller.uid,
      action: 'COMPANY_SETTINGS_CHANGED',
      entity: `companies/${companyId}`,
      previousState: {
        ...(nameChanged ? { name: currentName } : {}),
        ...(windowChanged ? { driverDeclineWindowMinutes: currentWindow } : {}),
      },
      newState: {
        ...(nameChanged ? { name: nextName } : {}),
        ...(windowChanged ? { driverDeclineWindowMinutes: nextWindow } : {}),
      },
      reason: 'Company settings changed by a company administrator',
    });
    return { status: 'updated', name: nextName, driverDeclineWindowMinutes: nextWindow };
  });
}

/**
 * The four counts the overview shows, from count queries so a large company is never loaded in
 * full. Each count matches what its own screen lists: an application is a member with
 * `driverRequestedAt` set (removal, approval and rejection clear it), a pending invitation is one
 * that is still PENDING and has not expired.
 */
export async function getCompanyOverview(
  deps: CompanyDashboardDeps,
  caller: CompanyCaller,
): Promise<{
  companyName: string;
  employees: number;
  pendingInvitations: number;
  driverApplications: number;
  approvedDrivers: number;
}> {
  const { firestore } = deps;
  const companyId = await requireActiveCompanyAdmin(firestore, caller);
  const members = firestore.collection(`companies/${companyId}/members`);
  const [company, employees, pending, applications, drivers] = await Promise.all([
    firestore.doc(`companies/${companyId}`).get(),
    members.where('status', '==', 'ACTIVE').count().get(),
    firestore
      .collection('companyInvitations')
      .where('companyId', '==', companyId)
      .where('status', '==', 'PENDING')
      .where('expiresAt', '>', Timestamp.fromMillis(nowOf(deps)))
      .count()
      .get(),
    members.where('driverRequestedAt', '!=', null).count().get(),
    members.where('status', '==', 'ACTIVE').where('canDrive', '==', true).count().get(),
  ]);
  return {
    companyName: String(company.get('name') ?? ''),
    employees: employees.data().count,
    pendingInvitations: pending.data().count,
    driverApplications: applications.data().count,
    approvedDrivers: drivers.data().count,
  };
}
