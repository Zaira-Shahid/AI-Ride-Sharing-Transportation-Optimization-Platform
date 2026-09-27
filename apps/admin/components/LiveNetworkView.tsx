'use client';

import {
  describeAuthError,
  listActiveTrips,
  subscribeToActiveVehicles,
  type ActiveVehicle,
} from '@ridemesh/firebase';
import { useAuth } from '@ridemesh/firebase/react';
import type { TripMonitoringRow } from '@ridemesh/types';
import { useCallback, useEffect, useState } from 'react';
import { EmptyState } from './EmptyState';
import { LiveMap } from './LiveMap';

const TRIP_POLL_MS = 15_000;
const UNMATCHED_STATUSES = new Set(['REQUESTED', 'SEARCHING']);

function Stat({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-4">
      <p className="text-xs uppercase tracking-wide text-clean-white/50">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-clean-white">{value ?? '—'}</p>
    </div>
  );
}

/**
 * Module 11.5 (admin dashboard: live map, first pass - vehicles only). Combines a LIVE vehicle
 * subscription (driverJourneys is directly staff-readable) with 11.4's own polled listActiveTrips
 * (tripRequests is not - see liveNetwork.ts's own comment) to build section 23's own count panel
 * ("Active vehicles / Active passengers / Open requests / Shared trips / Unmatched requests"),
 * without ever reading an exact pickup or destination. "Active passengers" and "Open requests" are
 * genuinely the SAME number, not just a display choice: docs/security.md's own "one open request
 * per passenger" invariant (a passenger can never have two open trip requests at once) means these
 * two counts are mathematically identical, always - section 23 just gives the one real number two
 * different labels/framings. "Unmatched requests" narrows that to requests with no driver yet
 * (REQUESTED/SEARCHING). Average occupancy, vehicles saved, emissions saved and network efficiency
 * are deliberately NOT here - deferred pending an agreed estimation methodology (section 33).
 */
export function LiveNetworkView() {
  const { client } = useAuth();
  const [vehicles, setVehicles] = useState<ActiveVehicle[] | null>(null);
  const [trips, setTrips] = useState<TripMonitoringRow[] | null>(null);
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
      setTrips(await listActiveTrips(client));
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

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Active vehicles" value={vehicles?.length ?? null} />
        <Stat label="Active passengers" value={trips?.length ?? null} />
        <Stat label="Open requests" value={trips?.length ?? null} />
        <Stat label="Shared trips" value={sharedCount} />
        <Stat label="Unmatched requests" value={unmatchedCount} />
      </div>
      <LiveMap vehicles={vehicles ?? []} />
    </div>
  );
}
