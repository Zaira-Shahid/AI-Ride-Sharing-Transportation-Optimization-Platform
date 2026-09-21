import { useEffect, useRef, useState } from 'react';
import type { LocationReading, LocationWatch, LocationWatchStatus } from './types';

/**
 * Follows the device's location in the browser while `enabled` is true, through the standard
 * geolocation API, and calls `onReading` with each reading. The browser asks for permission when
 * this is switched on (because the driver went online), and watching stops, and everything is
 * forgotten, as soon as `enabled` becomes false. Nothing is stored here: what is sent to the
 * server, and how often, is decided by the caller. Phones have their own file
 * (useLocationWatch.ts).
 */
export function useLocationWatch(
  enabled: boolean,
  onReading: (reading: LocationReading) => void,
): LocationWatch {
  const [status, setStatus] = useState<LocationWatchStatus>('idle');
  const latest = useRef(onReading);
  latest.current = onReading;

  useEffect(() => {
    if (!enabled) {
      setStatus('idle');
      return undefined;
    }
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setStatus('unavailable');
      return undefined;
    }
    let active = true;
    setStatus('starting');

    const id = navigator.geolocation.watchPosition(
      (position) => {
        if (!active) return;
        setStatus('watching');
        latest.current({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
          at: position.timestamp,
        });
      },
      (error) => {
        if (!active) return;
        // A refusal will not change by itself; anything else (no signal, a slow fix) may.
        setStatus(error.code === error.PERMISSION_DENIED ? 'denied' : 'unavailable');
      },
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 30_000 },
    );

    return () => {
      active = false;
      navigator.geolocation.clearWatch(id);
    };
  }, [enabled]);

  return { status };
}
