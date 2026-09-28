import { FieldPath, Timestamp, type Firestore, type Query } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { REVIEWER_ROLES, type StaffCaller } from './verification.js';

// Module 11.8 (admin dashboard: audit logs). See packages/types/src/auditLogs.ts's own comment for
// the scope this was checked and agreed against. `auditLogs` has no Firestore rule (never readable by
// clients); this function is the only way staff read it, limited to REVIEWER_ROLES like every other
// decision-level staff surface. Loading the list writes no audit entry.

export const AUDIT_LOG_PAGE_SIZE = 25;
export const AUDIT_FIELDS_ONLY_ACTIONS = ['VEHICLE_CREATED', 'VEHICLE_UPDATED'] as const;

export const listAuditLogsInputSchema = z.object({
  cursor: z
    .object({
      seconds: z.number().int(),
      nanoseconds: z.number().int().min(0).max(999_999_999),
      logId: z.string().trim().min(1).max(200),
    })
    .nullish(),
  action: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z_]{0,79}$/)
    .nullish(),
  actor: z.string().trim().min(1).max(200).nullish(),
});

export interface AuditLogRow {
  logId: string;
  timestamp: number;
  actor: string;
  actorName: string | null;
  actorEmail: string | null;
  action: string;
  entity: string;
  reason: string | null;
  previousState: Record<string, unknown> | null;
  newState: Record<string, unknown> | null;
  changedFields: string[] | null;
}

export interface ListAuditLogsResult {
  rows: AuditLogRow[];
  nextCursor: { seconds: number; nanoseconds: number; logId: string } | null;
}

function requireAuditAccess(caller: StaffCaller): void {
  const allowed = (REVIEWER_ROLES as readonly unknown[]).includes(caller.role);
  if (!allowed || !caller.emailVerified) {
    throw new HttpsError('permission-denied', 'You are not allowed to view the audit log.');
  }
}

/** A stored value made safe to send: timestamps become ISO strings, undefined becomes null. */
function toPlain(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof (value as { toMillis?: unknown }).toMillis === 'function') {
    return new Date((value as { toMillis: () => number }).toMillis()).toISOString();
  }
  if (Array.isArray(value)) return value.map(toPlain);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toPlain(item)]));
  }
  return value;
}

function toState(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return toPlain(value) as Record<string, unknown>;
}

/** The names of the fields that differ between two stored states (every field of the new one when there is no old one). */
function changedFieldNames(
  previous: Record<string, unknown> | null,
  next: Record<string, unknown> | null,
): string[] {
  const keys = new Set([...Object.keys(previous ?? {}), ...Object.keys(next ?? {})]);
  return [...keys]
    .filter((key) => JSON.stringify(previous?.[key]) !== JSON.stringify(next?.[key]))
    .sort();
}

/** `system` and `script:...` are not accounts; everything else is looked up in `users`. */
function isAccountActor(actor: string): boolean {
  return actor !== 'system' && !actor.startsWith('script:');
}

/**
 * The actor filter: an email becomes the uid of that account (nothing matches when none exists);
 * anything else - a uid, `system`, `script:...` - is matched exactly as stored.
 */
async function resolveActorFilter(firestore: Firestore, search: string): Promise<string | null> {
  if (!search.includes('@')) return search;
  const match = await firestore
    .collection('users')
    .where('email', '==', search.toLowerCase())
    .limit(1)
    .get();
  return match.docs[0]?.id ?? null;
}

export async function listAuditLogsForStaff(
  deps: { firestore: Firestore },
  caller: StaffCaller,
  rawInput: unknown,
): Promise<ListAuditLogsResult> {
  requireAuditAccess(caller);
  const parsed = listAuditLogsInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'The request is not valid.');
  }
  const { cursor, action, actor } = parsed.data;
  const { firestore } = deps;

  let actorFilter: string | null = null;
  if (actor) {
    actorFilter = await resolveActorFilter(firestore, actor);
    if (actorFilter === null) return { rows: [], nextCursor: null };
  }

  let query: Query = firestore.collection('auditLogs');
  if (action) query = query.where('action', '==', action);
  if (actorFilter) query = query.where('actor', '==', actorFilter);
  query = query
    .orderBy('timestamp', 'desc')
    .orderBy(FieldPath.documentId(), 'desc')
    .limit(AUDIT_LOG_PAGE_SIZE);
  // The cursor carries the timestamp's full precision: cut to milliseconds, entries written within
  // the same millisecond as the last one could be skipped on the next page.
  if (cursor) {
    query = query.startAfter(new Timestamp(cursor.seconds, cursor.nanoseconds), cursor.logId);
  }

  const snapshot = await query.get();

  const actorIds = [
    ...new Set(snapshot.docs.map((doc) => doc.get('actor')).filter(isStringAccountActor)),
  ];
  const actorDocs = actorIds.length
    ? await firestore.getAll(...actorIds.map((id) => firestore.collection('users').doc(id)))
    : [];
  const actors = new Map(
    actorDocs
      .filter((doc) => doc.exists)
      .map((doc) => [
        doc.id,
        {
          name: typeof doc.get('name') === 'string' ? (doc.get('name') as string) : null,
          email: typeof doc.get('email') === 'string' ? (doc.get('email') as string) : null,
        },
      ]),
  );

  const rows = snapshot.docs.map((doc): AuditLogRow => {
    const actorId = typeof doc.get('actor') === 'string' ? (doc.get('actor') as string) : '';
    const action = typeof doc.get('action') === 'string' ? (doc.get('action') as string) : '';
    const previousState = toState(doc.get('previousState'));
    const newState = toState(doc.get('newState'));
    const fieldsOnly = (AUDIT_FIELDS_ONLY_ACTIONS as readonly string[]).includes(action);
    const resolved = actors.get(actorId);
    return {
      logId: doc.id,
      timestamp: (doc.get('timestamp') as Timestamp).toMillis(),
      actor: actorId,
      actorName: resolved?.name ?? null,
      actorEmail: resolved?.email ?? null,
      action,
      entity: typeof doc.get('entity') === 'string' ? (doc.get('entity') as string) : '',
      reason: typeof doc.get('reason') === 'string' ? (doc.get('reason') as string) : null,
      previousState: fieldsOnly ? null : previousState,
      newState: fieldsOnly ? null : newState,
      changedFields: fieldsOnly ? changedFieldNames(previousState, newState) : null,
    };
  });

  const last = snapshot.docs.at(-1);
  const lastTimestamp = last?.get('timestamp') as Timestamp | undefined;
  const nextCursor =
    rows.length === AUDIT_LOG_PAGE_SIZE && last && lastTimestamp
      ? { seconds: lastTimestamp.seconds, nanoseconds: lastTimestamp.nanoseconds, logId: last.id }
      : null;
  return { rows, nextCursor };
}

function isStringAccountActor(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && isAccountActor(value);
}
