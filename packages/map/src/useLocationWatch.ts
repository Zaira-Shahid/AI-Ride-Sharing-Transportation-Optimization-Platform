import * as Location from 'expo-location';
import { useEffect, useRef, useState } from 'react';
import type { LocationReading, LocationWatch, LocationWatchStatus } from './types';

/**
 * Follows the device's location on phones while `enabled` is true, through expo-location, and calls
 * `onReading` with each reading. It uses the "while using the app" permission only, never a
 * background one, so it stops when the app is closed. It asks for permission when it is switched on
 * (which is because the driver went online, not on start-up) and stops watching, and forgets
 * everything, as soon as `enabled` becomes false. Nothing is stored here: what is sent to the server,
 * and how often, is decided by the caller. The web build has its own file (useLocationWatch.web.ts).
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
    let cancelled = false;
    let subscription: Location.LocationSubscription | null = null;
    setStatus('starting');

    void (async () => {
      try {
        const permission = await Location.requestForegroundPermissionsAsync();
        if (cancelled) return;
        if (permission.status !== 'granted') {
          setStatus('denied');
          return;
        }
        const started = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.Balanced, timeInterval: 10_000, distanceInterval: 20 },
          (position) => {
            if (cancelled) return;
            setStatus('watching');
            latest.current({
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
              accuracy: position.coords.accuracy ?? null,
              at: position.timestamp,
            });
          },
        );
        if (cancelled) started.remove();
        else subscription = started;
      } catch {
        if (!cancelled) setStatus('unavailable');
      }
    })();

    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [enabled]);

  return { status };
}
