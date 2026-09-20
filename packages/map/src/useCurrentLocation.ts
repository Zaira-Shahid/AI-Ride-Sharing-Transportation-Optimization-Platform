import * as Location from 'expo-location';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CurrentLocation, LocationStatus, MapPoint } from './types';

/**
 * The device's location on phones, through expo-location. It asks for permission only when the
 * person asks to be located, uses the "while using the app" permission, and never watches or
 * stores anything: one reading, kept in memory. The web build has its own file
 * (useCurrentLocation.web.ts).
 */
export function useCurrentLocation(): CurrentLocation {
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
    setStatus('locating');
    void (async () => {
      try {
        const permission = await Location.requestForegroundPermissionsAsync();
        if (!mounted.current) return;
        if (permission.status !== 'granted') {
          setStatus('denied');
          return;
        }
        const position = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        if (!mounted.current) return;
        setPoint({ latitude: position.coords.latitude, longitude: position.coords.longitude });
        setStatus('ready');
      } catch {
        if (mounted.current) setStatus('unavailable');
      }
    })();
  }, []);

  return { status, point, locate };
}
