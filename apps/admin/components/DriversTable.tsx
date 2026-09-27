'use client';

import { describeAuthError, listDriversForReview, submitStaffReview } from '@ridemesh/firebase';
import { useAuth } from '@ridemesh/firebase/react';
import type { ReviewDecision, ReviewTarget } from '@ridemesh/types';
import { useCallback, useEffect, useState } from 'react';
import { EmptyState } from './EmptyState';
import { ReviewActions } from './ReviewActions';

const REVIEWER_ROLES = new Set(['ADMIN', 'SUPER_ADMIN']);

type Row = Awaited<ReturnType<typeof listDriversForReview>>[number];

/**
 * Module 11.2 (admin dashboard: driver/vehicle management): one combined row per driver, their own
 * vehicle alongside it - the same "one person, one decision" shape staff actually review with, rather
 * than two unrelated lists. A one-shot fetch, re-run after every decision (see adminReview.ts's own
 * note on why this isn't a live subscription yet).
 */
export function DriversTable() {
  const { client, role } = useAuth();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submittingKey, setSubmittingKey] = useState<string | null>(null);
  const canReview = typeof role === 'string' && REVIEWER_ROLES.has(role);

  const load = useCallback(async () => {
    try {
      setRows(await listDriversForReview(client));
    } catch (caught) {
      setError(describeAuthError(caught).message);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const review = async (
    uid: string,
    target: ReviewTarget,
    decision: ReviewDecision,
    reason: string | null,
  ) => {
    const key = `${uid}-${target}`;
    setSubmittingKey(key);
    setError(null);
    try {
      await submitStaffReview(client, target, uid, decision, reason);
      await load();
    } catch (caught) {
      setError(describeAuthError(caught).message);
    } finally {
      setSubmittingKey(null);
    }
  };

  if (error) {
    return <EmptyState title="Could not load drivers" description={error} />;
  }
  if (!rows) {
    return <p className="text-sm text-clean-white/60">Loading…</p>;
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No drivers yet"
        description="Drivers will appear here once people register."
      />
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-white/10">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-white/10 text-xs uppercase tracking-wide text-clean-white/50">
          <tr>
            <th className="px-4 py-3 font-medium">Driver</th>
            <th className="px-4 py-3 font-medium">Driver status</th>
            <th className="px-4 py-3 font-medium">Vehicle</th>
            <th className="px-4 py-3 font-medium">Vehicle status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.uid}
              id={`driver-${row.uid}`}
              className="border-b border-white/5 last:border-0 target:bg-electric-cyan/10"
            >
              <td className="px-4 py-3 align-top">
                <p className="font-medium text-clean-white">{row.name}</p>
                <p className="text-xs text-clean-white/50">{row.email}</p>
              </td>
              <td className="px-4 py-3 align-top">
                <ReviewActions
                  status={row.driverVerificationStatus}
                  reason={row.driverVerificationReason}
                  canReview={canReview}
                  submitting={submittingKey === `${row.uid}-DRIVER`}
                  onReview={(decision, reason) => void review(row.uid, 'DRIVER', decision, reason)}
                />
              </td>
              <td className="px-4 py-3 align-top">
                {row.vehicle ? (
                  <>
                    <p className="text-clean-white">
                      {row.vehicle.make} {row.vehicle.model}
                    </p>
                    <p className="text-xs text-clean-white/50">
                      {row.vehicle.type} · {row.vehicle.plateNumber}
                    </p>
                  </>
                ) : (
                  <p className="text-xs text-clean-white/40">No vehicle saved</p>
                )}
              </td>
              <td className="px-4 py-3 align-top">
                {row.vehicle ? (
                  <ReviewActions
                    status={row.vehicle.verificationStatus}
                    reason={row.vehicle.verificationReason}
                    canReview={canReview}
                    submitting={submittingKey === `${row.uid}-VEHICLE`}
                    onReview={(decision, reason) =>
                      void review(row.uid, 'VEHICLE', decision, reason)
                    }
                  />
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
