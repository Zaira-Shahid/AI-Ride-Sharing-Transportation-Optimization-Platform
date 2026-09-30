'use client';

import {
  describeAuthError,
  getPaymentsSummary,
  getTripDetail,
  listPayments,
  refundPayment,
} from '@ridemesh/firebase';
import { useAuth } from '@ridemesh/firebase/react';
import type {
  PaymentListStatus,
  PaymentsCursor,
  PaymentsSummary,
  TripDetailForStaff,
  TripMonitoringRow,
} from '@ridemesh/types';
import { useCallback, useEffect, useState } from 'react';
import { EmptyState } from './EmptyState';

const REVIEWER_ROLES = new Set(['ADMIN', 'SUPER_ADMIN']);
const STATUS_OPTIONS: { value: PaymentListStatus | 'ALL'; label: string }[] = [
  { value: 'ALL', label: 'All (captured, failed, refunded)' },
  { value: 'CAPTURED', label: 'Captured' },
  { value: 'FAILED', label: 'Failed' },
  { value: 'REFUNDED', label: 'Refunded' },
  { value: 'PARTIALLY_REFUNDED', label: 'Partially refunded' },
];

function formatMoney(minorUnits: number | null): string {
  if (minorUnits === null) return '—';
  return `$${(minorUnits / 100).toFixed(2)}`;
}

function formatTime(millis: number): string {
  return millis > 0 ? new Date(millis).toLocaleString() : '—';
}

/**
 * Module 11.10 (admin dashboard: payments). Trips by payment status, newest first, paginated - the
 * same "no exact place in a list row, only via the audited getTripDetail" shape trip monitoring (11.4)
 * and disputes (11.7) already use. Any staff role may view this page; only ADMIN/SUPER_ADMIN may
 * issue a refund (the same "visibility for everyone, action for reviewers" split user management
 * uses) - refundPayment itself refuses anyone else regardless, this only hides the button.
 */
export function PaymentsTable() {
  const { client, role } = useAuth();
  const canRefund = typeof role === 'string' && REVIEWER_ROLES.has(role);

  const [statusFilter, setStatusFilter] = useState<PaymentListStatus | 'ALL'>('ALL');
  const [summary, setSummary] = useState<PaymentsSummary | null>(null);
  const [rows, setRows] = useState<TripMonitoringRow[]>([]);
  const [cursor, setCursor] = useState<PaymentsCursor | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<TripDetailForStaff | null>(null);
  const [detailLoading, setDetailLoading] = useState<string | null>(null);
  const [refunding, setRefunding] = useState<string | null>(null);
  const [refundReason, setRefundReason] = useState('');
  const [refundAmount, setRefundAmount] = useState('');
  const [refundSubmitting, setRefundSubmitting] = useState(false);

  useEffect(() => {
    getPaymentsSummary(client)
      .then(setSummary)
      .catch((caught) => setError(describeAuthError(caught).message));
  }, [client]);

  /**
   * A fresh first page for whatever filter is currently in effect - never reads the `cursor` state
   * (which may still hold the PREVIOUS filter's value at the moment a filter change fires this,
   * since state updates are not synchronous), always passing none explicitly instead.
   */
  const loadFirstPage = useCallback(async () => {
    setRows([]);
    setCursor(null);
    setDone(false);
    setDetail(null);
    setLoading(true);
    setError(null);
    try {
      const result = await listPayments(client, {
        paymentStatus: statusFilter === 'ALL' ? undefined : statusFilter,
        cursor: null,
      });
      setRows(result.rows);
      setCursor(result.nextCursor);
      setDone(result.nextCursor === null);
    } catch (caught) {
      setError(describeAuthError(caught).message);
    } finally {
      setLoading(false);
    }
  }, [client, statusFilter]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  const loadMore = async () => {
    if (!cursor) return;
    setLoading(true);
    setError(null);
    try {
      const result = await listPayments(client, {
        paymentStatus: statusFilter === 'ALL' ? undefined : statusFilter,
        cursor,
      });
      setRows((existing) => [...existing, ...result.rows]);
      setCursor(result.nextCursor);
      setDone(result.nextCursor === null);
    } catch (caught) {
      setError(describeAuthError(caught).message);
    } finally {
      setLoading(false);
    }
  };

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

  const reloadAfterRefund = async () => {
    await loadFirstPage();
    getPaymentsSummary(client)
      .then(setSummary)
      .catch(() => undefined);
  };

  const submitRefund = async (tripId: string) => {
    setRefundSubmitting(true);
    setError(null);
    try {
      await refundPayment(client, {
        tripId,
        reason: refundReason.trim(),
        amountMinorUnits: refundAmount.trim() ? Math.round(Number(refundAmount) * 100) : null,
      });
      setRefunding(null);
      setRefundReason('');
      setRefundAmount('');
      await reloadAfterRefund();
    } catch (caught) {
      setError(describeAuthError(caught).message);
    } finally {
      setRefundSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      {summary ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-white/10 p-4">
            <p className="text-xs uppercase tracking-wide text-clean-white/50">Total captured</p>
            <p className="mt-1 text-xl font-semibold text-clean-white">
              {formatMoney(summary.totalCapturedMinorUnits)}
            </p>
          </div>
          <div className="rounded-xl border border-white/10 p-4">
            <p className="text-xs uppercase tracking-wide text-clean-white/50">Total refunded</p>
            <p className="mt-1 text-xl font-semibold text-clean-white">
              {formatMoney(summary.totalRefundedMinorUnits)}
            </p>
          </div>
          <div className="rounded-xl border border-white/10 p-4">
            <p className="text-xs uppercase tracking-wide text-clean-white/50">Platform fee</p>
            <p className="mt-1 text-xl font-semibold text-clean-white">
              {formatMoney(summary.totalPlatformFeeMinorUnits)}
            </p>
          </div>
        </div>
      ) : null}

      <label className="block text-xs text-clean-white/60">
        Payment status
        <select
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value as PaymentListStatus | 'ALL')}
          className="mt-1 block w-72 rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-clean-white"
        >
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      {rows.length === 0 && !loading ? (
        <EmptyState title="No payments" description="Nothing matches this filter yet." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-white/10">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-white/10 text-xs uppercase tracking-wide text-clean-white/50">
              <tr>
                <th className="px-4 py-3 font-medium">Trip status</th>
                <th className="px-4 py-3 font-medium">Passenger</th>
                <th className="px-4 py-3 font-medium">Driver</th>
                <th className="px-4 py-3 font-medium">Requested</th>
                <th className="px-4 py-3 font-medium">Fare</th>
                <th className="px-4 py-3 font-medium">Payment</th>
                <th className="px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.tripId} className="border-b border-white/5 last:border-0">
                  <td className="px-4 py-3 align-top text-clean-white">{row.status}</td>
                  <td className="px-4 py-3 align-top text-clean-white">{row.passengerName}</td>
                  <td className="px-4 py-3 align-top text-clean-white/70">
                    {row.driverName ?? '—'}
                  </td>
                  <td className="px-4 py-3 align-top text-clean-white/70">
                    {formatTime(row.createdAt)}
                  </td>
                  <td className="px-4 py-3 align-top text-clean-white/70">
                    {formatMoney(row.finalFareMinorUnits)}
                  </td>
                  <td className="px-4 py-3 align-top text-clean-white/70">{row.paymentStatus}</td>
                  <td className="px-4 py-3 align-top">
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={detailLoading === row.tripId}
                        onClick={() => void openDetail(row.tripId)}
                        className="rounded-md border border-white/10 px-2 py-1 text-xs text-clean-white/70 hover:text-clean-white disabled:opacity-50"
                      >
                        View
                      </button>
                      {canRefund && row.paymentStatus === 'CAPTURED' ? (
                        <button
                          type="button"
                          onClick={() => {
                            setRefunding(row.tripId);
                            setRefundReason('');
                            setRefundAmount('');
                          }}
                          className="rounded-md border border-danger-red/60 px-2 py-1 text-xs font-medium text-danger-red"
                        >
                          Refund
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {error ? <p className="text-sm text-amber">{error}</p> : null}

      {!done ? (
        <button
          type="button"
          disabled={loading}
          onClick={() => void loadMore()}
          className="rounded-md border border-white/10 px-3 py-1.5 text-sm text-clean-white/70 hover:text-clean-white disabled:opacity-50"
        >
          {loading ? 'Loading…' : 'Load more'}
        </button>
      ) : null}

      {refunding ? (
        <div className="rounded-xl border border-danger-red/40 bg-white/5 p-4 text-sm">
          <p className="mb-2 font-medium text-clean-white">Refund trip {refunding}</p>
          <label className="block text-xs text-clean-white/60">
            Amount (optional - leave blank for a full refund)
            <input
              type="number"
              min="0.01"
              step="0.01"
              value={refundAmount}
              onChange={(event) => setRefundAmount(event.target.value)}
              placeholder="e.g. 12.50"
              disabled={refundSubmitting}
              className="mt-1 block w-48 rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-clean-white"
            />
          </label>
          <label className="mt-2 block text-xs text-clean-white/60">
            Reason (required)
            <input
              type="text"
              value={refundReason}
              onChange={(event) => setRefundReason(event.target.value)}
              placeholder="Why this refund is being issued"
              disabled={refundSubmitting}
              className="mt-1 block w-full rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-clean-white"
            />
          </label>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={refundSubmitting || refundReason.trim().length === 0}
              onClick={() => void submitRefund(refunding)}
              className="rounded-md bg-danger-red/80 px-3 py-1.5 text-sm font-medium text-clean-white disabled:opacity-50"
            >
              {refundSubmitting ? 'Refunding…' : 'Confirm refund'}
            </button>
            <button
              type="button"
              disabled={refundSubmitting}
              onClick={() => setRefunding(null)}
              className="rounded-md border border-white/10 px-3 py-1.5 text-sm text-clean-white/70 hover:text-clean-white"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

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
            <dt className="text-clean-white/50">Authorized</dt>
            <dd>{formatMoney(detail.authorizedAmountMinorUnits)}</dd>
            <dt className="text-clean-white/50">Final fare</dt>
            <dd>{formatMoney(detail.finalFareMinorUnits)}</dd>
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
