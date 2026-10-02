'use client';

import {
  describeAuthError,
  listActiveTripPositions,
  listActiveTrips,
  subscribeToActiveVehicles,
  type ActiveVehicle,
} from '@ridemesh/firebase';
import { useAuth } from '@ridemesh/firebase/react';
import type { LiveTripPosition, TripMonitoringRow } from '@ridemesh/types';
import { useCallback, useEffect, useState } from 'react';
import { EmptyState } from './EmptyState';
import { LiveMap } from './LiveMap';

const TRIP_POLL_MS = 15_000;
const UNMATCHED_STATUSES = new Set(['REQUESTED', 'SEARCHING']);
// Module 11.5, second pass: "network efficiency" has no spec formula (section 23 names it, nothing
// defines it) - user-confirmed definition is the share of right-now MATCHING/ACTIVE journeys (ones
// that have actually picked up at least one passenger - an AVAILABLE journey has picked up nobody
// yet, so it is excluded from both sides of this fraction) carrying more than one passenger. A
// genuinely live number, not Phase 12 Analytics' own cumulative/historical average occupancy.
const SHARED_JOURNEY_STATUSES = new Set(['MATCHING', 'ACTIVE']);

function networkEfficiencyPercent(vehicles: ActiveVehicle[] | null): number | null {
  if (!vehicles) return null;
  const matched = vehicles.filter((vehicle) => SHARED_JOURNEY_STATUSES.has(vehicle.status));
  if (matched.length === 0) return null;
  const shared = matched.filter((vehicle) => vehicle.passengerCount > 1).length;
  return Math.round((shared / matched.length) * 100);
}

function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: number | string | null;
  note?: string;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-4">
      <p className="text-xs uppercase tracking-wide text-clean-white/50">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-clean-white">{value ?? '—'}</p>
      {note ? <p className="mt-1 text-xs text-clean-white/50">{note}</p> : null}
    </div>
  );
}

function LegendDot({ color, shape = 'circle' }: { color: string; shape?: 'circle' | 'diamond' }) {
  return (
    <span
      className="inline-block h-2.5 w-2.5 shrink-0 border border-white/40"
      style={{
        background: color,
        borderRadius: shape === 'circle' ? '9999px' : 0,
        transform: shape === 'diamond' ? 'rotate(45deg)' : undefined,
      }}
    />
  );
}

/**
 * Module 11.5 (admin dashboard: live map). Combines a LIVE vehicle subscription (driverJourneys is
 * directly staff-readable) with 11.4's own polled listActiveTrips (tripRequests is not - see
 * liveNetwork.ts's own comment) to build section 23's own count panel ("Active vehicles / Active
 * passengers / Open requests / Shared trips / Unmatched requests / Current network efficiency"),
 * plus a second pass adding the map's own pickup/drop-off/unmatched-request markers and high-demand
 * heatmap (listActiveTripPositions, polled the same way, since every position it returns is already
 * rounded server-side - never the exact place). "Active passengers" and "Open requests" are
 * genuinely the SAME number, not just a display choice: docs/security.md's own "one open request
 * per passenger" invariant (a passenger can never have two open trip requests at once) means these
 * two counts are mathematically identical, always - section 23 just gives the one real number two
 * different labels/framings. "Unmatched requests" narrows that to requests with no driver yet
 * (REQUESTED/SEARCHING). Average occupancy, vehicles saved and emissions saved stay on Phase 12's own
 * Analytics page (its own cumulative/historical numbers, not this page's live ones) - only "network
 * efficiency" belongs here, since section 23 itself asks for the CURRENT figure.
 */
export function LiveNetworkView() {
  const { client } = useAuth();
  const [vehicles, setVehicles] = useState<ActiveVehicle[] | null>(null);
  const [trips, setTrips] = useState<TripMonitoringRow[] | null>(null);
  const [tripPositions, setTripPositions] = useState<LiveTripPosition[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return subscribeToActiveVehicles(
      client,
      (next) => setVehicles(next),
      (caught) => setError(describeAuthError(caught).message),
    );
  }, [client]);

  const loadTrips = useCallback(async () => {
    try {
      const [activeTrips, positions] = await Promise.all([
        listActiveTrips(client),
        listActiveTripPositions(client),
      ]);
      setTrips(activeTrips);
      setTripPositions(positions);
    } catch (caught) {
      setError(describeAuthError(caught).message);
    }
  }, [client]);

  useEffect(() => {
    void loadTrips();
    const interval = setInterval(() => void loadTrips(), TRIP_POLL_MS);
    return () => clearInterval(interval);
  }, [loadTrips]);

  if (error) {
    return <EmptyState title="Could not load the live network" description={error} />;
  }

  const unmatchedCount =
    trips?.filter((trip) => UNMATCHED_STATUSES.has(trip.status)).length ?? null;
  const sharedCount = trips?.filter((trip) => trip.sharedRide).length ?? null;
  const efficiency = networkEfficiencyPercent(vehicles);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Active vehicles" value={vehicles?.length ?? null} />
        <Stat label="Active passengers" value={trips?.length ?? null} />
        <Stat label="Open requests" value={trips?.length ?? null} />
        <Stat label="Shared trips" value={sharedCount} />
        <Stat label="Unmatched requests" value={unmatchedCount} />
        <Stat
          label="Network efficiency"
          value={efficiency === null ? null : `${efficiency}%`}
          note="Share of currently matched journeys carrying more than one passenger - our own definition"
        />
      </div>
      <LiveMap vehicles={vehicles ?? []} tripPositions={tripPositions ?? []} />
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-clean-white/60">
        <span className="flex items-center gap-1.5">
          <LegendDot color="#22d3ee" /> Vehicle
        </span>
        <span className="flex items-center gap-1.5">
          <LegendDot color="#94a3b8" /> Pickup (matched)
        </span>
        <span className="flex items-center gap-1.5">
          <LegendDot color="#f59e0b" /> Pickup (unmatched)
        </span>
        <span className="flex items-center gap-1.5">
          <LegendDot color="#60a5fa" shape="diamond" /> Drop-off
        </span>
        <span className="flex items-center gap-1.5">
          <LegendDot color="rgba(239,68,68,0.4)" /> Demand (rounded positions, ~11 m)
        </span>
      </div>
    </div>
  );
}
