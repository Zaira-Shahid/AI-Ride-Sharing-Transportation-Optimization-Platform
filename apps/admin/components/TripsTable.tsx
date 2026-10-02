'use client';

import {
  describeAuthError,
  getTripDetail,
  listActiveTrips,
  listTripHistory,
} from '@ridemesh/firebase';
import { useAuth } from '@ridemesh/firebase/react';
import type { TripDetailForStaff, TripHistoryCursor, TripMonitoringRow } from '@ridemesh/types';
import { useCallback, useEffect, useState } from 'react';
import { EmptyState } from './EmptyState';

const LIVE_POLL_MS = 15_000;
/** Shown for a place the retention sweep has cleared (30 days after the trip ended). */
export const PLACE_REMOVED = 'Removed (retention: 30 days after the trip ended)';

function formatMoney(minorUnits: number | null): string {
  if (minorUnits === null) return '—';
  return `$${(minorUnits / 100).toFixed(2)}`;
}

function formatTime(millis: number): string {
  return millis > 0 ? new Date(millis).toLocaleString() : '—';
}

/**
 * Module 11.4 (admin dashboard: trip monitoring). Two tabs: a polled "live" view of currently-open
 * trips, and a paginated history of completed/cancelled ones - both list-only, no exact place (see
 * packages/firebase/src/tripMonitoring.ts's own comment on why this can't be a direct Firestore read).
 * Opening a row's detail is a SEPARATE audited call (getTripDetail) - the only place exact pickup and
 * destination addresses ever appear here.
 */
export function TripsTable() {
  const { client } = useAuth();
  const [tab, setTab] = useState<'live' | 'history'>('live');
  const [liveRows, setLiveRows] = useState<TripMonitoringRow[] | null>(null);
  const [historyRows, setHistoryRows] = useState<TripMonitoringRow[]>([]);
  const [historyCursor, setHistoryCursor] = useState<TripHistoryCursor | null>(null);
  const [historyDone, setHistoryDone] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<TripDetailForStaff | null>(null);
  const [detailLoading, setDetailLoading] = useState<string | null>(null);

  const loadLive = useCallback(async () => {
    try {
      setLiveRows(await listActiveTrips(client));
    } catch (caught) {
      setError(describeAuthError(caught).message);
    }
  }, [client]);

  useEffect(() => {
    if (tab !== 'live') return;
    void loadLive();
    const interval = setInterval(() => void loadLive(), LIVE_POLL_MS);
    return () => clearInterval(interval);
  }, [tab, loadLive]);

  const loadMoreHistory = useCallback(async () => {
    setHistoryLoading(true);
    setError(null);
    try {
      const result = await listTripHistory(client, historyCursor);
      setHistoryRows((existing) => [...existing, ...result.rows]);
      setHistoryCursor(result.nextCursor);
      setHistoryDone(result.nextCursor === null);
    } catch (caught) {
      setError(describeAuthError(caught).message);
    } finally {
      setHistoryLoading(false);
    }
  }, [client, historyCursor]);

  useEffect(() => {
    if (tab === 'history' && historyRows.length === 0 && !historyLoading && !historyDone) {
      void loadMoreHistory();
    }
    // Only ever auto-loads the FIRST page; "Load more" drives every page after.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

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

  const rows = tab === 'live' ? liveRows : historyRows;

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setTab('live')}
          className={`rounded-md px-3 py-1.5 text-sm font-medium ${
            tab === 'live' ? 'bg-electric-cyan/20 text-electric-cyan' : 'text-clean-white/60'
          }`}
        >
          Live
        </button>
        <button
          type="button"
          onClick={() => setTab('history')}
          className={`rounded-md px-3 py-1.5 text-sm font-medium ${
            tab === 'history' ? 'bg-electric-cyan/20 text-electric-cyan' : 'text-clean-white/60'
          }`}
        >
          History
        </button>
      </div>

      {error ? <EmptyState title="Could not load trips" description={error} /> : null}

      {!error && (rows === null || (tab === 'history' && historyLoading && rows.length === 0)) ? (
        <p className="text-sm text-clean-white/60">Loading…</p>
      ) : null}

      {!error && rows !== null && rows.length === 0 && !historyLoading ? (
        <EmptyState
          title={tab === 'live' ? 'No active trips' : 'No trip history yet'}
          description="Trips will appear here once the network is active."
        />
      ) : null}

      {!error && rows !== null && rows.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-white/10">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-white/10 text-xs uppercase tracking-wide text-clean-white/50">
              <tr>
                <th className="px-4 py-3 font-medium">Status</th>
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
                  <td className="px-4 py-3 align-top text-clean-white/70">
                    {row.paymentStatus ?? '—'}
                  </td>
                  <td className="px-4 py-3 align-top">
                    <button
                      type="button"
                      disabled={detailLoading === row.tripId}
                      onClick={() => void openDetail(row.tripId)}
                      className="rounded-md border border-white/10 px-2 py-1 text-xs text-clean-white/70 hover:text-clean-white disabled:opacity-50"
                    >
                      View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {tab === 'history' && !historyDone && rows !== null && rows.length > 0 ? (
        <button
          type="button"
          disabled={historyLoading}
          onClick={() => void loadMoreHistory()}
          className="rounded-md border border-white/10 px-3 py-1.5 text-sm text-clean-white/70 hover:text-clean-white disabled:opacity-50"
        >
          {historyLoading ? 'Loading…' : 'Load more'}
        </button>
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
            <dt className="text-clean-white/50">Pickup</dt>
            <dd>{detail.origin?.formattedAddress ?? PLACE_REMOVED}</dd>
            <dt className="text-clean-white/50">Destination</dt>
            <dd>{detail.destination?.formattedAddress ?? PLACE_REMOVED}</dd>
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
