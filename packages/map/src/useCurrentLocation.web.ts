import { useCallback, useEffect, useRef, useState } from 'react';
import type { CurrentLocation, LocateOptions, LocationStatus, MapPoint } from './types';

// A reading this old is good enough for showing where the person is on a map.
const DEFAULT_MAX_AGE_MS = 60_000;

/**
 * The device's location in the browser, through the standard geolocation API. The browser asks the
 * person for permission when this is called, which is only when they ask to be located. One reading,
 * kept in memory; nothing is watched or stored. Phones have their own file (useCurrentLocation.ts).
 */
export function useCurrentLocation(options: LocateOptions = {}): CurrentLocation {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const [status, setStatus] = useState<LocationStatus>('idle');
  const [point, setPoint] = useState<MapPoint | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const locate = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setStatus('unavailable');
      return;
    }
    setStatus('locating');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (!mounted.current) return;
        setPoint({ latitude: position.coords.latitude, longitude: position.coords.longitude });
        setStatus('ready');
      },
      (error) => {
        if (!mounted.current) return;
        setStatus(error.code === error.PERMISSION_DENIED ? 'denied' : 'unavailable');
      },
      { enableHighAccuracy: false, timeout: 15_000, maximumAge: maxAgeMs },
    );
  }, [maxAgeMs]);

  return { status, point, locate };
}
