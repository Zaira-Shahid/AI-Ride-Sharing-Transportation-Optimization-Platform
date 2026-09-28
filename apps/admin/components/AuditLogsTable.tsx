'use client';

import { describeAuthError, listAuditLogs } from '@ridemesh/firebase';
import { useAuth } from '@ridemesh/firebase/react';
import { AUDIT_LOG_ACTIONS, type AuditLogCursor, type AuditLogRow } from '@ridemesh/types';
import { useCallback, useEffect, useState } from 'react';
import { EmptyState } from './EmptyState';

function formatTime(millis: number): string {
  return millis > 0 ? new Date(millis).toLocaleString() : '—';
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function StateList({ title, state }: { title: string; state: Record<string, unknown> | null }) {
  return (
    <div>
      <p className="mb-1 text-xs uppercase tracking-wide text-clean-white/50">{title}</p>
      {state && Object.keys(state).length > 0 ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-clean-white/80">
          {Object.entries(state).map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-clean-white/50">{key}</dt>
              <dd className="break-all">{formatValue(value)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-clean-white/50">—</p>
      )}
    </div>
  );
}

/**
 * Module 11.8 (admin dashboard: audit logs). The audit trail, newest first, for ADMIN and
 * SUPER_ADMIN staff only (the function refuses anyone else). Entries name no exact place, so nothing
 * here tries to reconstruct one; a vehicle entry lists only which fields changed, never their values.
 * Opening this page is not itself audited.
 */
export function AuditLogsTable() {
  const { client } = useAuth();
  const [rows, setRows] = useState<AuditLogRow[] | null>(null);
  const [cursor, setCursor] = useState<AuditLogCursor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [actionInput, setActionInput] = useState('');
  const [actorInput, setActorInput] = useState('');
  const [filters, setFilters] = useState<{ action?: string; actor?: string }>({});

  const loadFirstPage = useCallback(async () => {
    setRows(null);
    setError(null);
    setExpanded(null);
    try {
      const result = await listAuditLogs(client, filters);
      setRows(result.rows);
      setCursor(result.nextCursor);
    } catch (caught) {
      setError(describeAuthError(caught).message);
    }
  }, [client, filters]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    setError(null);
    try {
      const result = await listAuditLogs(client, { ...filters, cursor });
      setRows((current) => [...(current ?? []), ...result.rows]);
      setCursor(result.nextCursor);
    } catch (caught) {
      setError(describeAuthError(caught).message);
    } finally {
      setLoadingMore(false);
    }
  };

  const applyFilters = (event: React.FormEvent) => {
    event.preventDefault();
    setFilters({
      action: actionInput.trim().toUpperCase() || undefined,
      actor: actorInput.trim() || undefined,
    });
  };

  const clearFilters = () => {
    setActionInput('');
    setActorInput('');
    setFilters({});
  };

  const filtersBar = (
    <form onSubmit={applyFilters} className="flex flex-wrap items-end gap-3">
      <label className="text-xs text-clean-white/60">
        Action
        <input
          list="audit-log-actions"
          value={actionInput}
          onChange={(event) => setActionInput(event.target.value)}
          placeholder="e.g. USER_STATUS_CHANGED"
          className="mt-1 block w-64 rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-clean-white"
        />
        <datalist id="audit-log-actions">
          {AUDIT_LOG_ACTIONS.map((action) => (
            <option key={action} value={action} />
          ))}
        </datalist>
      </label>
      <label className="text-xs text-clean-white/60">
        Actor
        <input
          value={actorInput}
          onChange={(event) => setActorInput(event.target.value)}
          placeholder="email, uid, system or script:…"
          className="mt-1 block w-64 rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-clean-white"
        />
      </label>
      <button
        type="submit"
        className="rounded-md bg-emerald/80 px-3 py-1.5 text-sm font-medium text-midnight-navy"
      >
        Apply
      </button>
      <button
        type="button"
        onClick={clearFilters}
        className="rounded-md border border-white/10 px-3 py-1.5 text-sm text-clean-white/70 hover:text-clean-white"
      >
        Clear
      </button>
    </form>
  );

  if (error && !rows) {
    return <EmptyState title="Could not load the audit log" description={error} />;
  }

  return (
    <div className="space-y-4">
      {filtersBar}

      {!rows ? (
        <p className="text-sm text-clean-white/60">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No audit entries"
          description="Nothing matches. Every important change and staff action is recorded here."
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-white/10">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-white/10 text-xs uppercase tracking-wide text-clean-white/50">
              <tr>
                <th className="px-4 py-3 font-medium">Time</th>
                <th className="px-4 py-3 font-medium">Action</th>
                <th className="px-4 py-3 font-medium">Actor</th>
                <th className="px-4 py-3 font-medium">Entity</th>
                <th className="px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const open = expanded === row.logId;
                return (
                  <FragmentRow
                    key={row.logId}
                    row={row}
                    open={open}
                    onToggle={() => setExpanded(open ? null : row.logId)}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {error && rows ? <p className="text-sm text-amber">{error}</p> : null}

      {rows && cursor ? (
        <button
          type="button"
          disabled={loadingMore}
          onClick={() => void loadMore()}
          className="rounded-md border border-white/10 px-3 py-1.5 text-sm text-clean-white/70 hover:text-clean-white disabled:opacity-50"
        >
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      ) : null}
    </div>
  );
}

function FragmentRow({
  row,
  open,
  onToggle,
}: {
  row: AuditLogRow;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className="border-b border-white/5 last:border-0">
        <td className="px-4 py-3 align-top text-clean-white/70">{formatTime(row.timestamp)}</td>
        <td className="px-4 py-3 align-top text-clean-white">{row.action}</td>
        <td className="px-4 py-3 align-top text-clean-white/80">
          {row.actorName || row.actorEmail ? (
            <>
              <span>{row.actorName ?? row.actorEmail}</span>
              {row.actorName && row.actorEmail ? (
                <span className="block text-xs text-clean-white/50">{row.actorEmail}</span>
              ) : null}
            </>
          ) : (
            row.actor
          )}
        </td>
        <td className="px-4 py-3 align-top break-all text-clean-white/70">{row.entity}</td>
        <td className="px-4 py-3 align-top">
          <button
            type="button"
            aria-expanded={open}
            onClick={onToggle}
            className="rounded-md border border-white/10 px-2 py-1 text-xs text-clean-white/70 hover:text-clean-white"
          >
            {open ? 'Hide' : 'Details'}
          </button>
        </td>
      </tr>
      {open ? (
        <tr className="border-b border-white/5 bg-white/5">
          <td colSpan={5} className="px-4 py-3 text-sm">
            <div className="space-y-3">
              <p className="text-clean-white/80">
                <span className="text-clean-white/50">Reason: </span>
                {row.reason ?? '—'}
              </p>
              {row.changedFields ? (
                <div>
                  <p className="mb-1 text-xs uppercase tracking-wide text-clean-white/50">
                    Fields changed
                  </p>
                  <p className="text-clean-white/80">
                    {row.changedFields.length > 0 ? row.changedFields.join(', ') : '—'}
                  </p>
                  <p className="mt-1 text-xs text-clean-white/50">
                    Values are not shown for vehicle entries.
                  </p>
                </div>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  <StateList title="Previous state" state={row.previousState} />
                  <StateList title="New state" state={row.newState} />
                </div>
              )}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
