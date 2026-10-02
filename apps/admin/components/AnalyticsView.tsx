'use client';

import { describeAuthError, getAnalyticsSummary } from '@ridemesh/firebase';
import { useAuth } from '@ridemesh/firebase/react';
import type { AnalyticsSummary } from '@ridemesh/types';
import { useEffect, useState } from 'react';
import { EmptyState } from './EmptyState';

function formatNumber(value: number | null, digits = 0): string {
  return value === null ? '—' : value.toFixed(digits);
}

function formatPercent(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(0)}%`;
}

function formatDistance(meters: number | null): string {
  if (meters === null) return '—';
  return `${(meters / 1000).toFixed(2)} km`;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  const minutes = seconds / 60;
  return minutes >= 1 ? `${minutes.toFixed(1)} min` : `${Math.round(seconds)} s`;
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-xl border border-white/10 p-4">
      <p className="text-xs uppercase tracking-wide text-clean-white/50">{label}</p>
      <p className="mt-1 text-xl font-semibold text-clean-white">{value}</p>
      {note ? <p className="mt-1 text-xs text-clean-white/50">{note}</p> : null}
    </div>
  );
}

/**
 * Module 12 (Analytics). Phase 12's own 12 named metrics (spec), minus "average passenger walking
 * distance" - no real number exists anywhere in this codebase to compute it from, so it is never
 * shown (the same stance module 11.9 already takes for "compatibility %" and walking distance).
 * Every other number here is real - see functions/src/analytics.ts's own header comment for the exact
 * formula behind each one; several (occupancy, vehicle trips avoided, emissions avoided) are THIS
 * project's own chosen definitions, not an industry-standard formula, and are labeled as such below.
 * Platform-wide totals only, computed on demand - any staff role may view this page.
 */
export function AnalyticsView() {
  const { client } = useAuth();
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAnalyticsSummary(client)
      .then(setSummary)
      .catch((caught) => setError(describeAuthError(caught).message));
  }, [client]);

  if (error) {
    return <EmptyState title="Could not load analytics" description={error} />;
  }
  if (!summary) {
    return <p className="text-sm text-clean-white/60">Loading…</p>;
  }

  return (
    <div className="space-y-6">
      {summary.distinctCountsCapped ? (
        <p
          role="note"
          className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-clean-white/80"
        >
          There are more than {formatNumber(summary.distinctTripCap)} completed trips, so People
          transported and Vehicles used count only the most recent{' '}
          {formatNumber(summary.distinctTripCap)}: the real figures are at least these. Vehicle
          trips avoided and the emissions estimate are not shown, because they are made from those
          two.
        </p>
      ) : null}
      <section>
        <h2 className="mb-2 text-sm font-medium text-clean-white/70">Volume</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Tile label="Trips completed" value={formatNumber(summary.tripsCompleted)} />
          <Tile
            label="People transported"
            value={formatNumber(summary.peopleTransported)}
            note="Distinct passengers, not total rides"
          />
          <Tile
            label="Vehicles used"
            value={formatNumber(summary.vehiclesUsed)}
            note="Distinct drivers"
          />
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium text-clean-white/70">Matching and sharing</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Tile
            label="Average occupancy"
            value={formatNumber(summary.averageOccupancy, 2)}
            note="Completed trips ÷ completed journeys - our own definition"
          />
          <Tile
            label="Vehicle trips avoided"
            value={formatNumber(summary.vehicleTripsAvoided)}
            note="People transported − journeys made - our own formula"
          />
          <Tile
            label="Average matching time"
            value={formatDuration(summary.averageMatchingTimeSeconds)}
            note={
              summary.averageMatchingTimeSeconds === null
                ? 'No matches recorded since this was added'
                : 'Not retroactive - only matches since this was added'
            }
          />
          <Tile
            label="Average detour (distance)"
            value={formatDistance(summary.averageDetourMeters)}
            note="From recent optimization runs only (module 11.9's own retention window)"
          />
          <Tile
            label="Average detour (time)"
            value={formatDuration(summary.averageDetourSeconds)}
            note="Same source and window as distance, above"
          />
          <Tile
            label="Unmatched requests"
            value={formatNumber(summary.unmatchedRequests)}
            note="Right now, not historical"
          />
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium text-clean-white/70">Reliability</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Tile label="Cancellation rate" value={formatPercent(summary.cancellationRate)} />
          <Tile label="Payment success rate" value={formatPercent(summary.paymentSuccessRate)} />
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium text-clean-white/70">Environmental (estimate)</h2>
        <div className="rounded-xl border border-amber/40 bg-amber/5 p-4">
          <p className="text-xs uppercase tracking-wide text-amber">
            Estimate - unverified methodology
          </p>
          <p className="mt-1 text-xl font-semibold text-clean-white">
            {summary.estimatedEmissionsAvoidedKg === null
              ? '—'
              : `${summary.estimatedEmissionsAvoidedKg.toFixed(1)} kg CO₂`}
          </p>
          <p className="mt-2 text-xs text-clean-white/60">
            Vehicle trips avoided × this system&apos;s own average trip distance × an assumed 120 g
            CO₂/km per car (a commonly cited average, not measured for this fleet). Not a verified
            methodology - do not treat as exact.
          </p>
        </div>
      </section>
    </div>
  );
}
