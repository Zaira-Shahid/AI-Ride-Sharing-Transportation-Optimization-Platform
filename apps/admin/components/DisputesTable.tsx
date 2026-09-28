'use client';

import {
  describeAuthError,
  getTripDetail,
  listDisputedTrips,
  markDisputeReviewed,
  type DisputedTripRow,
} from '@ridemesh/firebase';
import { useAuth } from '@ridemesh/firebase/react';
import type { TripDetailForStaff } from '@ridemesh/types';
import { useCallback, useEffect, useState } from 'react';
import { EmptyState } from './EmptyState';

function formatMoney(minorUnits: number | null): string {
  if (minorUnits === null) return '—';
  return `$${(minorUnits / 100).toFixed(2)}`;
}

function formatTime(millis: number): string {
  return millis > 0 ? new Date(millis).toLocaleString() : '—';
}

/**
 * Module 11.7 (admin dashboard: disputes). Every trip whose payment is currently DISPUTED,
 * not-yet-reviewed ones first - the actionable queue. Read-only otherwise (no refund action here, a
 * separate later decision); "Mark reviewed" is a work-queue marker, not a payment state change.
 * Opening a row's detail is the SAME audited getTripDetail call module 11.4 already built.
 */
export function DisputesTable() {
  const { client } = useAuth();
  const [rows, setRows] = useState<DisputedTripRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<TripDetailForStaff | null>(null);
  const [detailLoading, setDetailLoading] = useState<string | null>(null);
  const [reviewingId, setReviewingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await listDisputedTrips(client));
    } catch (caught) {
      setError(describeAuthError(caught).message);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const openDetail = async (tripId: string) => {
    setDetailLoading(tripId);
    setError(null);
    try {
      setDetail(await getTripDetail(client, tripId));
    } catch (caught) {
      setError(describeAuthError(caught).message);
    } finally {
      setDetailLoading(null);
    }
  };

  const markReviewed = async (tripId: string) => {
    setReviewingId(tripId);
    setError(null);
    try {
      await markDisputeReviewed(client, tripId);
      await load();
    } catch (caught) {
      setError(describeAuthError(caught).message);
    } finally {
      setReviewingId(null);
    }
  };

  if (error) {
    return <EmptyState title="Could not load disputes" description={error} />;
  }
  if (!rows) {
    return <p className="text-sm text-clean-white/60">Loading…</p>;
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No disputes"
        description="Disputed payments (Stripe chargebacks) will appear here."
      />
    );
  }

  const sorted = [...rows].sort((a, b) => Number(a.disputeReviewed) - Number(b.disputeReviewed));

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-xl border border-white/10">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-white/10 text-xs uppercase tracking-wide text-clean-white/50">
            <tr>
              <th className="px-4 py-3 font-medium">Trip status</th>
              <th className="px-4 py-3 font-medium">Passenger</th>
              <th className="px-4 py-3 font-medium">Driver</th>
              <th className="px-4 py-3 font-medium">Requested</th>
              <th className="px-4 py-3 font-medium">Fare</th>
              <th className="px-4 py-3 font-medium">Reviewed</th>
              <th className="px-4 py-3 font-medium" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr key={row.tripId} className="border-b border-white/5 last:border-0">
                <td className="px-4 py-3 align-top text-clean-white">{row.status}</td>
                <td className="px-4 py-3 align-top text-clean-white">{row.passengerName}</td>
                <td className="px-4 py-3 align-top text-clean-white/70">{row.driverName ?? '—'}</td>
                <td className="px-4 py-3 align-top text-clean-white/70">
                  {formatTime(row.createdAt)}
                </td>
                <td className="px-4 py-3 align-top text-clean-white/70">
                  {formatMoney(row.finalFareMinorUnits)}
                </td>
                <td className="px-4 py-3 align-top">
                  <span
                    className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                      row.disputeReviewed ? 'bg-emerald/15 text-emerald' : 'bg-amber/15 text-amber'
                    }`}
                  >
                    {row.disputeReviewed ? 'Reviewed' : 'Not reviewed'}
                  </span>
                </td>
                <td className="px-4 py-3 align-top">
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={detailLoading === row.tripId}
                      onClick={() => void openDetail(row.tripId)}
                      className="rounded-md border border-white/10 px-2 py-1 text-xs text-clean-white/70 hover:text-clean-white disabled:opacity-50"
                    >
                      View
                    </button>
                    {!row.disputeReviewed ? (
                      <button
                        type="button"
                        disabled={reviewingId === row.tripId}
                        onClick={() => void markReviewed(row.tripId)}
                        className="rounded-md bg-emerald/80 px-2 py-1 text-xs font-medium text-midnight-navy disabled:opacity-50"
                      >
                        Mark reviewed
                      </button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {detail ? (
        <div className="rounded-xl border border-electric-cyan/40 bg-white/5 p-4 text-sm">
          <div className="mb-2 flex items-center justify-between">
            <p className="font-medium text-clean-white">Trip {detail.tripId}</p>
            <button
              type="button"
              onClick={() => setDetail(null)}
              className="text-xs text-clean-white/60 hover:text-clean-white"
            >
              Close
            </button>
          </div>
          <dl className="grid grid-cols-2 gap-2 text-clean-white/80">
            <dt className="text-clean-white/50">Pickup</dt>
            <dd>{detail.origin.formattedAddress}</dd>
            <dt className="text-clean-white/50">Destination</dt>
            <dd>{detail.destination.formattedAddress}</dd>
            <dt className="text-clean-white/50">Vehicle</dt>
            <dd>
              {detail.vehicleMake && detail.vehicleModel
                ? `${detail.vehicleMake} ${detail.vehicleModel} (${detail.vehicleType ?? ''})`
                : '—'}
            </dd>
            <dt className="text-clean-white/50">Authorized</dt>
            <dd>{formatMoney(detail.authorizedAmountMinorUnits)}</dd>
            <dt className="text-clean-white/50">Refunded</dt>
            <dd>{formatMoney(detail.refundedAmountMinorUnits)}</dd>
            <dt className="text-clean-white/50">Platform fee</dt>
            <dd>{formatMoney(detail.platformFeeMinorUnits)}</dd>
          </dl>
        </div>
      ) : null}
    </div>
  );
}
