import {
  FieldPath,
  FieldValue,
  Timestamp,
  type DocumentSnapshot,
  type Firestore,
  type Transaction,
} from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { enforceCallRateLimit } from './callLimits.js';
import {
  COMPANY_ROLES,
  CompanyClaimsError,
  clearCompanyClaims,
  setCompanyClaims,
  type CompanyRole,
} from './companyClaims.js';
import { generateInvitationCode, parseInvitationCode, tokenMatchesHash } from './invitationCode.js';
import type { RoleDeps } from './registration.js';

// Company onboarding (module A2a, docs/a2-company-onboarding-design.md): create a company, invite
// and accept employees, list and remove them, change their role. Functions deploy from this
// directory alone, so the limits and schemas below intentionally mirror @ridemesh/tenancy;
// tests/tenancy-parity.test.ts fails if they diverge.

export const COMPANY_NAME_MAX = 100;
export const PERSON_NAME_MAX = 100;
export const PHONE_MAX = 32;
export const EMAIL_MAX = 254;
export const COMPANY_CREATIONS_PER_ACCOUNT_PER_DAY = 3;
export const INVITES_PER_ADMIN_PER_HOUR = 30;
export const MAX_PENDING_INVITATIONS = 200;
export const EMPLOYEES_PAGE_SIZE = 50;
export const INVITATIONS_LIST_LIMIT = 100;
export const INVITATION_TTL_DAYS = 7;
/** The platform-wide ceiling on new companies per day, unless COMPANY_CREATIONS_PER_DAY says otherwise. */
export const DEFAULT_COMPANY_CREATIONS_PER_DAY = 50;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const nameSchema = z.string().trim().min(1).max(PERSON_NAME_MAX);
const phoneSchema = z.string().trim().min(1).max(PHONE_MAX).nullish();
const documentIdSchema = z.string().trim().min(1).max(128);
const companyRoleSchema = z.enum(COMPANY_ROLES);

export const createCompanyInputSchema = z.object({
  name: z.string().trim().min(2).max(COMPANY_NAME_MAX),
  ownerName: nameSchema,
  phone: phoneSchema,
});
export const inviteEmployeeInputSchema = z.object({
  email: z.string().trim().toLowerCase().max(EMAIL_MAX).pipe(z.email()),
  // null (what the Firebase client sends for an undefined field) means the default.
  companyRole: companyRoleSchema.nullish().transform((role) => role ?? 'EMPLOYEE'),
});
export const acceptInvitationInputSchema = z.object({
  code: z.string().trim().min(1).max(200),
  name: nameSchema,
  phone: phoneSchema,
});
export const revokeInvitationInputSchema = z.object({ invitationId: documentIdSchema });
export const listEmployeesInputSchema = z.object({ cursor: documentIdSchema.nullish() });
export const removeEmployeeInputSchema = z.object({ uid: documentIdSchema });
export const setEmployeeRoleInputSchema = z.object({
  uid: documentIdSchema,
  companyRole: companyRoleSchema,
});

export interface CompanyCaller {
  uid: string;
  role: unknown;
  emailVerified: boolean;
  companyId: unknown;
}

export interface CompanyDeps extends RoleDeps {
  /** Overrides the platform-wide daily company limit (tests). */
  maxCompaniesPerDay?: number;
}

export function companyCreationsPerDayFromEnvironment(): number {
  const raw = Number(process.env.COMPANY_CREATIONS_PER_DAY);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_COMPANY_CREATIONS_PER_DAY;
}

const NOT_ADMIN = 'Only a company administrator can do this.';
const INVITATION_NOT_VALID = 'This invitation is not valid or has expired.';
const ALREADY_HAS_ROLE = 'This account already has a role and cannot join or create a company.';

function parse<T extends z.ZodType>(schema: T, raw: unknown, message: string): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HttpsError('invalid-argument', message);
  return parsed.data;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function millis(value: unknown): number | null {
  return value instanceof Timestamp ? value.toMillis() : null;
}

function isCompanyRole(value: unknown): value is CompanyRole {
  return typeof value === 'string' && (COMPANY_ROLES as readonly string[]).includes(value);
}

function nowOf(deps: { now?: () => number }): number {
  return (deps.now ?? Date.now)();
}

function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function audit(
  tx: Transaction,
  firestore: Firestore,
  entry: {
    actor: string;
    action: string;
    entity: string;
    previousState: Record<string, unknown> | null;
    newState: Record<string, unknown> | null;
    reason: string;
  },
): void {
  tx.create(firestore.collection('auditLogs').doc(), {
    timestamp: FieldValue.serverTimestamp(),
    ...entry,
  });
}

/**
 * A company claim problem becomes a plain refusal. Anything else is a real failure and is left to
 * surface as one.
 */
async function withClaims(work: Promise<unknown>): Promise<void> {
  try {
    await work;
  } catch (error) {
    if (error instanceof CompanyClaimsError) {
      throw new HttpsError('failed-precondition', error.message);
    }
    throw error;
  }
}

/**
 * The caller must be an active administrator of an active company. The check reads the membership
 * document, never the token alone, because a claim can be an hour stale after someone is demoted.
 * Returns the company id.
 */
export async function requireActiveCompanyAdmin(
  firestore: Firestore,
  caller: CompanyCaller,
): Promise<string> {
  const companyId = text(caller.companyId);
  if (!caller.emailVerified || caller.role !== 'EMPLOYEE' || companyId === null) {
    throw new HttpsError('permission-denied', NOT_ADMIN);
  }
  const [member, company] = await Promise.all([
    firestore.doc(`companies/${companyId}/members/${caller.uid}`).get(),
    firestore.doc(`companies/${companyId}`).get(),
  ]);
  if (
    !member.exists ||
    member.get('status') !== 'ACTIVE' ||
    member.get('companyRole') !== 'COMPANY_ADMIN' ||
    !company.exists ||
    company.get('status') !== 'ACTIVE'
  ) {
    throw new HttpsError('permission-denied', NOT_ADMIN);
  }
  return companyId;
}

/** A new employee profile. Consumer profiles never carry a companyId. */
function employeeProfile(input: {
  name: string;
  email: string;
  phone: string | null;
  companyId: string;
}) {
  return {
    role: 'EMPLOYEE',
    name: input.name,
    email: input.email,
    phone: input.phone,
    photoUrl: null,
    status: 'ACTIVE',
    statusReason: null,
    pushToken: null,
    companyId: input.companyId,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

// ---------------------------------------------------------------------------------------------
// Company creation

/**
 * Creates a company with the caller as its first administrator. Anyone with a verified email and
 * no role may (Q4: no platform approval), limited per account and platform-wide. Repeating the
 * call after a partial failure repairs the claims and returns the same company.
 */
export async function createCompany(
  deps: CompanyDeps,
  caller: CompanyCaller,
  rawInput: unknown,
): Promise<{ companyId: string; status: 'created' | 'unchanged' }> {
  if (!caller.emailVerified) {
    throw new HttpsError('permission-denied', 'Verify your email address first.');
  }
  const input = parse(createCompanyInputSchema, rawInput, 'The company details are not valid.');
  const { firestore, auth } = deps;
  const now = nowOf(deps);

  const [authUser, profile] = await Promise.all([
    auth.getUser(caller.uid),
    firestore.doc(`users/${caller.uid}`).get(),
  ]);
  const email = text(authUser.email)?.toLowerCase();
  if (!email) throw new HttpsError('failed-precondition', 'This account has no email address.');

  if (profile.exists) {
    // Only the account that created a company may repeat the call, to repair its own claims.
    const existingCompanyId = text(profile.get('companyId'));
    if (profile.get('role') === 'EMPLOYEE' && existingCompanyId !== null) {
      const [member, company] = await Promise.all([
        firestore.doc(`companies/${existingCompanyId}/members/${caller.uid}`).get(),
        firestore.doc(`companies/${existingCompanyId}`).get(),
      ]);
      if (
        member.exists &&
        member.get('companyRole') === 'COMPANY_ADMIN' &&
        member.get('status') === 'ACTIVE' &&
        company.exists &&
        company.get('createdBy') === caller.uid
      ) {
        await withClaims(
          setCompanyClaims(auth, caller.uid, {
            companyId: existingCompanyId,
            companyRole: 'COMPANY_ADMIN',
          }),
        );
        return { companyId: existingCompanyId, status: 'unchanged' };
      }
    }
    throw new HttpsError('failed-precondition', ALREADY_HAS_ROLE);
  }
  if (authUser.customClaims?.role !== undefined) {
    throw new HttpsError('failed-precondition', ALREADY_HAS_ROLE);
  }

  await enforceCallRateLimit(firestore, 'createCompany', caller.uid, now, {
    windowMs: DAY_MS,
    maxCalls: COMPANY_CREATIONS_PER_ACCOUNT_PER_DAY,
  });

  const maxPerDay = deps.maxCompaniesPerDay ?? companyCreationsPerDayFromEnvironment();
  const companyRef = firestore.collection('companies').doc();
  const memberRef = companyRef.collection('members').doc(caller.uid);
  const profileRef = firestore.doc(`users/${caller.uid}`);
  const counterRef = firestore.doc(`companyLimits/creations_${dayKey(now)}`);

  await firestore.runTransaction(async (tx) => {
    const [existingProfile, counter] = await Promise.all([tx.get(profileRef), tx.get(counterRef)]);
    if (existingProfile.exists) throw new HttpsError('failed-precondition', ALREADY_HAS_ROLE);
    const created: unknown = counter.get('count');
    const todaysCount = typeof created === 'number' ? created : 0;
    if (todaysCount >= maxPerDay) {
      throw new HttpsError(
        'resource-exhausted',
        'New companies cannot be created right now. Please try again tomorrow.',
      );
    }

    tx.set(counterRef, { count: todaysCount + 1, updatedAt: FieldValue.serverTimestamp() });
    tx.create(companyRef, {
      name: input.name,
      status: 'ACTIVE',
      createdBy: caller.uid,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.create(memberRef, {
      companyRole: 'COMPANY_ADMIN',
      status: 'ACTIVE',
      canDrive: false,
      driverReviewedBy: null,
      driverReviewedAt: null,
      joinedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.create(
      profileRef,
      employeeProfile({
        name: input.ownerName,
        email,
        phone: input.phone ?? null,
        companyId: companyRef.id,
      }),
    );
    audit(tx, firestore, {
      actor: caller.uid,
      action: 'COMPANY_CREATED',
      entity: `companies/${companyRef.id}`,
      previousState: null,
      newState: { name: input.name, status: 'ACTIVE' },
      reason: 'Company created by its first administrator',
    });
  });

  await withClaims(
    setCompanyClaims(auth, caller.uid, { companyId: companyRef.id, companyRole: 'COMPANY_ADMIN' }),
  );
  return { companyId: companyRef.id, status: 'created' };
}

// ---------------------------------------------------------------------------------------------
// Invitations

type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';

function invitationStatus(snapshot: DocumentSnapshot, now: number): InvitationStatus {
  const status: unknown = snapshot.get('status');
  const expiresAt = millis(snapshot.get('expiresAt'));
  if (status === 'PENDING' && expiresAt !== null && expiresAt <= now) return 'EXPIRED';
  if (status === 'ACCEPTED' || status === 'REVOKED' || status === 'EXPIRED') return status;
  return 'PENDING';
}

/**
 * Creates an invitation and returns its code, once. The code is not stored (only its hash is) and
 * is never logged. The admin shares it themselves.
 */
export async function inviteEmployee(
  deps: CompanyDeps,
  caller: CompanyCaller,
  rawInput: unknown,
): Promise<{ invitationId: string; code: string; expiresAt: number }> {
  const { firestore } = deps;
  const companyId = await requireActiveCompanyAdmin(firestore, caller);
  const input = parse(
    inviteEmployeeInputSchema,
    rawInput,
    'The email address or role is not valid.',
  );
  const now = nowOf(deps);

  await enforceCallRateLimit(firestore, 'inviteEmployee', caller.uid, now, {
    windowMs: HOUR_MS,
    maxCalls: INVITES_PER_ADMIN_PER_HOUR,
  });

  // Someone who is already an active member of this company needs no invitation.
  const existing = await firestore
    .collection('users')
    .where('email', '==', input.email)
    .where('companyId', '==', companyId)
    .limit(1)
    .get();
  const existingUser = existing.docs[0];
  if (existingUser) {
    const member = await firestore.doc(`companies/${companyId}/members/${existingUser.id}`).get();
    if (member.exists && member.get('status') === 'ACTIVE') {
      throw new HttpsError(
        'failed-precondition',
        'That person is already a member of your company.',
      );
    }
  }

  const invitationRef = firestore.collection('companyInvitations').doc();
  const { code, tokenHash } = generateInvitationCode(invitationRef.id);
  const expiresAt = now + INVITATION_TTL_DAYS * DAY_MS;

  await firestore.runTransaction(async (tx) => {
    const pending = await tx.get(
      firestore
        .collection('companyInvitations')
        .where('companyId', '==', companyId)
        .where('status', '==', 'PENDING')
        .limit(MAX_PENDING_INVITATIONS + 1),
    );
    const live = pending.docs.filter((doc) => invitationStatus(doc, now) === 'PENDING');
    if (live.some((doc) => doc.get('email') === input.email)) {
      throw new HttpsError(
        'failed-precondition',
        'That email already has a pending invitation. Revoke it first to send a new one.',
      );
    }
    if (live.length >= MAX_PENDING_INVITATIONS) {
      throw new HttpsError(
        'resource-exhausted',
        'There are too many pending invitations. Revoke some and try again.',
      );
    }
    // An expired invitation for this email is closed so it cannot linger as PENDING.
    for (const doc of pending.docs) {
      if (doc.get('email') === input.email && invitationStatus(doc, now) === 'EXPIRED') {
        tx.update(doc.ref, { status: 'EXPIRED' });
      }
    }

    tx.create(invitationRef, {
      companyId,
      email: input.email,
      tokenHash,
      companyRole: input.companyRole,
      status: 'PENDING',
      expiresAt: Timestamp.fromMillis(expiresAt),
      createdBy: caller.uid,
      createdAt: FieldValue.serverTimestamp(),
    });
    audit(tx, firestore, {
      actor: caller.uid,
      action: 'EMPLOYEE_INVITED',
      entity: `companyInvitations/${invitationRef.id}`,
      previousState: null,
      newState: { companyId, email: input.email, companyRole: input.companyRole },
      reason: 'Invitation created',
    });
  });

  return { invitationId: invitationRef.id, code, expiresAt };
}

export async function listInvitations(
  deps: CompanyDeps,
  caller: CompanyCaller,
): Promise<{
  rows: {
    invitationId: string;
    email: string;
    companyRole: CompanyRole;
    status: InvitationStatus;
    createdAt: number;
    expiresAt: number;
  }[];
}> {
  const { firestore } = deps;
  const companyId = await requireActiveCompanyAdmin(firestore, caller);
  const now = nowOf(deps);
  const snapshot = await firestore
    .collection('companyInvitations')
    .where('companyId', '==', companyId)
    .orderBy('createdAt', 'desc')
    .limit(INVITATIONS_LIST_LIMIT)
    .get();
  // Neither the code nor its hash is ever returned.
  return {
    rows: snapshot.docs.map((doc) => {
      const role: unknown = doc.get('companyRole');
      return {
        invitationId: doc.id,
        email: text(doc.get('email')) ?? '',
        companyRole: isCompanyRole(role) ? role : 'EMPLOYEE',
        status: invitationStatus(doc, now),
        createdAt: millis(doc.get('createdAt')) ?? 0,
        expiresAt: millis(doc.get('expiresAt')) ?? 0,
      };
    }),
  };
}

export async function revokeInvitation(
  deps: CompanyDeps,
  caller: CompanyCaller,
  rawInput: unknown,
): Promise<{ status: 'revoked' | 'unchanged' }> {
  const { firestore } = deps;
  const companyId = await requireActiveCompanyAdmin(firestore, caller);
  const { invitationId } = parse(
    revokeInvitationInputSchema,
    rawInput,
    'The request is not valid.',
  );
  const ref = firestore.doc(`companyInvitations/${invitationId}`);

  return firestore.runTransaction(async (tx): Promise<{ status: 'revoked' | 'unchanged' }> => {
    const snapshot = await tx.get(ref);
    // Another company's invitation looks the same as one that does not exist.
    if (!snapshot.exists || snapshot.get('companyId') !== companyId) {
      throw new HttpsError('not-found', 'There is no invitation with that ID.');
    }
    const status = invitationStatus(snapshot, nowOf(deps));
    if (status === 'REVOKED') return { status: 'unchanged' };
    if (status === 'ACCEPTED') {
      throw new HttpsError('failed-precondition', 'That invitation has already been used.');
    }
    tx.update(ref, { status: 'REVOKED' });
    audit(tx, firestore, {
      actor: caller.uid,
      action: 'INVITATION_REVOKED',
      entity: `companyInvitations/${invitationId}`,
      previousState: { status },
      newState: { status: 'REVOKED' },
      reason: 'Invitation revoked by a company administrator',
    });
    return { status: 'revoked' };
  });
}

/**
 * Joins the company an invitation names. The account must have a verified email equal to the
 * invited one and no role: a consumer or staff account is refused here, at accept time, so an
 * administrator never learns whether an email already has an account. A person who was removed and
 * is invited again is reactivated. Repeating the call after a partial failure repairs the claims.
 */
export async function acceptInvitation(
  deps: CompanyDeps,
  caller: CompanyCaller,
  rawInput: unknown,
): Promise<{ companyId: string; companyRole: CompanyRole; status: 'accepted' | 'unchanged' }> {
  if (!caller.emailVerified) {
    throw new HttpsError('permission-denied', 'Verify your email address first.');
  }
  const input = parse(
    acceptInvitationInputSchema,
    rawInput,
    'The invitation details are not valid.',
  );
  const { firestore, auth } = deps;
  const now = nowOf(deps);

  await enforceCallRateLimit(firestore, 'acceptInvitation', caller.uid, now, {
    windowMs: HOUR_MS,
    maxCalls: 10,
  });

  const parsedCode = parseInvitationCode(input.code);
  if (!parsedCode) throw new HttpsError('failed-precondition', INVITATION_NOT_VALID);
  const invitationRef = firestore.doc(`companyInvitations/${parsedCode.invitationId}`);
  const invitation = await invitationRef.get();
  if (!invitation.exists || !tokenMatchesHash(parsedCode.token, invitation.get('tokenHash'))) {
    throw new HttpsError('failed-precondition', INVITATION_NOT_VALID);
  }

  const companyId = text(invitation.get('companyId'));
  const roleValue: unknown = invitation.get('companyRole');
  if (companyId === null || !isCompanyRole(roleValue)) {
    throw new HttpsError('failed-precondition', INVITATION_NOT_VALID);
  }
  const companyRole: CompanyRole = roleValue;
  const status = invitationStatus(invitation, now);

  if (status === 'ACCEPTED' && invitation.get('acceptedBy') === caller.uid) {
    // The same person repeating the call: make sure they have their claims.
    await withClaims(setCompanyClaims(auth, caller.uid, { companyId, companyRole }));
    return { companyId, companyRole, status: 'unchanged' };
  }
  if (status !== 'PENDING') throw new HttpsError('failed-precondition', INVITATION_NOT_VALID);

  const authUser = await auth.getUser(caller.uid);
  const email = text(authUser.email)?.toLowerCase();
  if (!email || email !== invitation.get('email')) {
    throw new HttpsError(
      'failed-precondition',
      'This invitation was sent to a different email address.',
    );
  }
  const claimedRole: unknown = authUser.customClaims?.role;
  const claimedCompany: unknown = authUser.customClaims?.companyId;
  if (claimedRole !== undefined && (claimedRole !== 'EMPLOYEE' || claimedCompany !== companyId)) {
    throw new HttpsError('failed-precondition', ALREADY_HAS_ROLE);
  }

  const companyRef = firestore.doc(`companies/${companyId}`);
  const memberRef = companyRef.collection('members').doc(caller.uid);
  const profileRef = firestore.doc(`users/${caller.uid}`);

  await firestore.runTransaction(async (tx) => {
    const [freshInvitation, company, profile, member] = await Promise.all([
      tx.get(invitationRef),
      tx.get(companyRef),
      tx.get(profileRef),
      tx.get(memberRef),
    ]);
    if (invitationStatus(freshInvitation, now) !== 'PENDING') {
      throw new HttpsError('failed-precondition', INVITATION_NOT_VALID);
    }
    if (!company.exists || company.get('status') !== 'ACTIVE') {
      throw new HttpsError('failed-precondition', INVITATION_NOT_VALID);
    }

    if (profile.exists) {
      // Only someone removed from this same company may come back; every other profile is a
      // consumer, a staff member or a member of another company.
      const comesBack =
        profile.get('role') === 'EMPLOYEE' &&
        profile.get('companyId') === companyId &&
        member.exists &&
        member.get('status') === 'REMOVED';
      if (!comesBack) throw new HttpsError('failed-precondition', ALREADY_HAS_ROLE);
      tx.update(profileRef, {
        name: input.name,
        phone: input.phone ?? null,
        status: 'ACTIVE',
        statusReason: null,
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.update(memberRef, {
        companyRole,
        status: 'ACTIVE',
        canDrive: false,
        driverReviewedBy: null,
        driverReviewedAt: null,
        joinedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      tx.create(
        profileRef,
        employeeProfile({ name: input.name, email, phone: input.phone ?? null, companyId }),
      );
      tx.create(memberRef, {
        companyRole,
        status: 'ACTIVE',
        canDrive: false,
        driverReviewedBy: null,
        driverReviewedAt: null,
        joinedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    tx.update(invitationRef, {
      status: 'ACCEPTED',
      acceptedBy: caller.uid,
      acceptedAt: FieldValue.serverTimestamp(),
    });
    audit(tx, firestore, {
      actor: caller.uid,
      action: 'INVITATION_ACCEPTED',
      entity: `companyInvitations/${parsedCode.invitationId}`,
      previousState: { status: 'PENDING' },
      newState: { status: 'ACCEPTED', companyId, companyRole },
      reason: 'Invitation accepted',
    });
  });

  await withClaims(setCompanyClaims(auth, caller.uid, { companyId, companyRole }));
  return { companyId, companyRole, status: 'accepted' };
}

// ---------------------------------------------------------------------------------------------
// Employees

export async function listEmployees(
  deps: CompanyDeps,
  caller: CompanyCaller,
  rawInput: unknown,
): Promise<{
  rows: {
    uid: string;
    name: string | null;
    email: string | null;
    companyRole: CompanyRole;
    status: 'ACTIVE' | 'REMOVED';
    canDrive: boolean;
    joinedAt: number | null;
  }[];
  nextCursor: string | null;
}> {
  const { firestore } = deps;
  const companyId = await requireActiveCompanyAdmin(firestore, caller);
  const { cursor } = parse(listEmployeesInputSchema, rawInput ?? {}, 'The request is not valid.');

  let query = firestore
    .collection(`companies/${companyId}/members`)
    .orderBy(FieldPath.documentId())
    .limit(EMPLOYEES_PAGE_SIZE + 1);
  if (cursor) query = query.startAfter(cursor);
  const snapshot = await query.get();

  const page = snapshot.docs.slice(0, EMPLOYEES_PAGE_SIZE);
  const profiles = page.length
    ? await firestore.getAll(...page.map((doc) => firestore.doc(`users/${doc.id}`)))
    : [];
  const profileOf = new Map(profiles.map((profile) => [profile.id, profile]));

  return {
    rows: page.map((doc) => {
      const profile = profileOf.get(doc.id);
      const role: unknown = doc.get('companyRole');
      return {
        uid: doc.id,
        name: text(profile?.get('name')),
        email: text(profile?.get('email')),
        companyRole: isCompanyRole(role) ? role : 'EMPLOYEE',
        status: doc.get('status') === 'REMOVED' ? ('REMOVED' as const) : ('ACTIVE' as const),
        canDrive: doc.get('canDrive') === true,
        joinedAt: millis(doc.get('joinedAt')),
      };
    }),
    nextCursor:
      snapshot.docs.length > EMPLOYEES_PAGE_SIZE ? (page[page.length - 1]?.id ?? null) : null,
  };
}

/** Refuses the change when it would leave the company with no active administrator. */
async function assertNotLastAdmin(
  tx: Transaction,
  firestore: Firestore,
  companyId: string,
): Promise<void> {
  const admins = await tx.get(
    firestore
      .collection(`companies/${companyId}/members`)
      .where('companyRole', '==', 'COMPANY_ADMIN')
      .where('status', '==', 'ACTIVE')
      .limit(2),
  );
  if (admins.size <= 1) {
    throw new HttpsError(
      'failed-precondition',
      'A company needs at least one administrator. Make someone else an administrator first.',
    );
  }
}

/**
 * Removes an employee: the membership is kept as REMOVED (so past rides still count as numbers),
 * the profile is suspended, and the claims are cleared and tokens revoked. Nothing is deleted.
 */
export async function removeEmployee(
  deps: CompanyDeps,
  caller: CompanyCaller,
  rawInput: unknown,
): Promise<{ status: 'removed' | 'unchanged' }> {
  const { firestore, auth } = deps;
  const companyId = await requireActiveCompanyAdmin(firestore, caller);
  const { uid } = parse(removeEmployeeInputSchema, rawInput, 'The request is not valid.');
  const memberRef = firestore.doc(`companies/${companyId}/members/${uid}`);
  const profileRef = firestore.doc(`users/${uid}`);

  const result = await firestore.runTransaction(
    async (tx): Promise<{ status: 'removed' | 'unchanged' }> => {
      const member = await tx.get(memberRef);
      if (!member.exists) {
        throw new HttpsError('not-found', 'There is no employee with that ID in your company.');
      }
      const previousRole: unknown = member.get('companyRole');
      if (member.get('status') === 'REMOVED') return { status: 'unchanged' };
      if (member.get('companyRole') === 'COMPANY_ADMIN') {
        await assertNotLastAdmin(tx, firestore, companyId);
      }
      tx.update(memberRef, {
        status: 'REMOVED',
        canDrive: false,
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.update(profileRef, {
        status: 'SUSPENDED',
        statusReason: 'Removed from the company',
        updatedAt: FieldValue.serverTimestamp(),
      });
      audit(tx, firestore, {
        actor: caller.uid,
        action: 'EMPLOYEE_REMOVED',
        entity: `companies/${companyId}/members/${uid}`,
        previousState: { status: 'ACTIVE', companyRole: previousRole },
        newState: { status: 'REMOVED' },
        reason: 'Removed by a company administrator',
      });
      return { status: 'removed' };
    },
  );

  // Claims and tokens last, outside the transaction: a repeat call finds the member REMOVED and
  // returns early, so clear them whenever the call is a removal or a repeat of one.
  await clearCompanyClaims(auth, uid);
  return result;
}

export async function setEmployeeRole(
  deps: CompanyDeps,
  caller: CompanyCaller,
  rawInput: unknown,
): Promise<{ status: 'changed' | 'unchanged' }> {
  const { firestore, auth } = deps;
  const companyId = await requireActiveCompanyAdmin(firestore, caller);
  const { uid, companyRole } = parse(
    setEmployeeRoleInputSchema,
    rawInput,
    'The request is not valid.',
  );
  const memberRef = firestore.doc(`companies/${companyId}/members/${uid}`);

  const result = await firestore.runTransaction(
    async (tx): Promise<{ status: 'changed' | 'unchanged' }> => {
      const member = await tx.get(memberRef);
      if (!member.exists || member.get('status') !== 'ACTIVE') {
        throw new HttpsError(
          'not-found',
          'There is no active employee with that ID in your company.',
        );
      }
      const previous: unknown = member.get('companyRole');
      if (previous === companyRole) return { status: 'unchanged' };
      if (previous === 'COMPANY_ADMIN') await assertNotLastAdmin(tx, firestore, companyId);
      tx.update(memberRef, { companyRole, updatedAt: FieldValue.serverTimestamp() });
      audit(tx, firestore, {
        actor: caller.uid,
        action: 'EMPLOYEE_ROLE_CHANGED',
        entity: `companies/${companyId}/members/${uid}`,
        previousState: { companyRole: previous },
        newState: { companyRole },
        reason: 'Role changed by a company administrator',
      });
      return { status: 'changed' };
    },
  );

  if (result.status === 'changed') {
    await withClaims(setCompanyClaims(auth, uid, { companyId, companyRole }));
  }
  return result;
}
