'use client';

import { listVehiclesForReview, type StatusCursor } from '@ridemesh/firebase';
import { useAuth } from '@ridemesh/firebase/react';
import Link from 'next/link';
import { useCallback } from 'react';
import { EmptyState } from './EmptyState';
import { LoadMoreButton } from './LoadMoreButton';
import { usePagedList } from './usePagedList';

type Row = Awaited<ReturnType<typeof listVehiclesForReview>>['rows'][number];

const STATUS_STYLES: Record<Row['verificationStatus'], string> = {
  PENDING: 'bg-amber/15 text-amber',
  VERIFIED: 'bg-emerald/15 text-emerald',
  REJECTED: 'bg-danger-red/15 text-danger-red',
};

/**
 * Module 11.6 (admin dashboard: vehicle management, standalone page). Read-only by design (scoped
 * with the user): every saved vehicle, fleet-first rather than driver-first, PENDING ones first.
 * Verify/reject stays on the Drivers page (module 11.2) - the "Manage" link here jumps straight to
 * that driver's own row there (DriversTable's own #driver-{uid} anchor), so there is exactly one
 * place a verification decision is made and audited.
 */
export function VehiclesTable() {
  const { client } = useAuth();
  const loadPage = useCallback(
    (cursor: StatusCursor | null) => listVehiclesForReview(client, { cursor }),
    [client],
  );
  const { rows, error, hasMore, loadingMore, loadMore } = usePagedList<Row, StatusCursor>(loadPage);

  if (error) {
    return <EmptyState title="Could not load vehicles" description={error} />;
  }
  if (!rows) {
    return <p className="text-sm text-clean-white/60">Loading…</p>;
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No vehicles yet"
        description="Vehicles will appear here once drivers save one."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-xl border border-white/10">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-white/10 text-xs uppercase tracking-wide text-clean-white/50">
            <tr>
              <th className="px-4 py-3 font-medium">Vehicle</th>
              <th className="px-4 py-3 font-medium">Driver</th>
              <th className="px-4 py-3 font-medium">Seats</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.driverId} className="border-b border-white/5 last:border-0">
                <td className="px-4 py-3 align-top">
                  <p className="font-medium text-clean-white">
                    {row.make} {row.model}
                  </p>
                  <p className="text-xs text-clean-white/50">
                    {row.type ?? '—'} · {row.plateNumber}
                  </p>
                </td>
                <td className="px-4 py-3 align-top">
                  <p className="text-clean-white">{row.driverName}</p>
                  <p className="text-xs text-clean-white/50">{row.driverEmail}</p>
                </td>
                <td className="px-4 py-3 align-top text-clean-white/70">
                  {row.seatCapacity ?? '—'}
                </td>
                <td className="px-4 py-3 align-top">
                  <span
                    className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[row.verificationStatus]}`}
                  >
                    {row.verificationStatus}
                  </span>
                  {row.verificationStatus === 'REJECTED' && row.verificationReason ? (
                    <p className="mt-1 text-xs text-clean-white/50">{row.verificationReason}</p>
                  ) : null}
                </td>
                <td className="px-4 py-3 align-top">
                  <Link
                    href={`/drivers#driver-${row.driverId}`}
                    className="rounded-md border border-white/10 px-2 py-1 text-xs text-clean-white/70 hover:text-clean-white"
                  >
                    Manage
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <LoadMoreButton visible={hasMore} loading={loadingMore} onClick={() => void loadMore()} />
    </div>
  );
}
