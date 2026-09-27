'use client';

import { describeAuthError, listPassengersForReview, submitUserStatus } from '@ridemesh/firebase';
import { useAuth } from '@ridemesh/firebase/react';
import type { UserStatus } from '@ridemesh/types';
import { useCallback, useEffect, useState } from 'react';
import { EmptyState } from './EmptyState';
import { UserStatusActions } from './UserStatusActions';

const REVIEWER_ROLES = new Set(['ADMIN', 'SUPER_ADMIN']);

type Row = Awaited<ReturnType<typeof listPassengersForReview>>[number];

/**
 * Module 11.3 (admin dashboard: user management): one row per passenger, suspended ones first - the
 * same "one-shot fetch, re-run after every decision" shape as DriversTable's own driver queue.
 */
export function PassengersTable() {
  const { client, role } = useAuth();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submittingUid, setSubmittingUid] = useState<string | null>(null);
  const canManage = typeof role === 'string' && REVIEWER_ROLES.has(role);

  const load = useCallback(async () => {
    try {
      setRows(await listPassengersForReview(client));
    } catch (caught) {
      setError(describeAuthError(caught).message);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const changeStatus = async (uid: string, status: UserStatus, reason: string | null) => {
    setSubmittingUid(uid);
    setError(null);
    try {
      await submitUserStatus(client, uid, status, reason);
      await load();
    } catch (caught) {
      setError(describeAuthError(caught).message);
    } finally {
      setSubmittingUid(null);
    }
  };

  if (error) {
    return <EmptyState title="Could not load passengers" description={error} />;
  }
  if (!rows) {
    return <p className="text-sm text-clean-white/60">Loading…</p>;
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No passengers yet"
        description="Passengers will appear here once people register."
      />
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-white/10">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-white/10 text-xs uppercase tracking-wide text-clean-white/50">
          <tr>
            <th className="px-4 py-3 font-medium">Passenger</th>
            <th className="px-4 py-3 font-medium">Account status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.uid} className="border-b border-white/5 last:border-0">
              <td className="px-4 py-3 align-top">
                <p className="font-medium text-clean-white">{row.name}</p>
                <p className="text-xs text-clean-white/50">{row.email}</p>
              </td>
              <td className="px-4 py-3 align-top">
                <UserStatusActions
                  status={row.status}
                  reason={row.statusReason}
                  canManage={canManage}
                  submitting={submittingUid === row.uid}
                  onChange={(status, reason) => void changeStatus(row.uid, status, reason)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
