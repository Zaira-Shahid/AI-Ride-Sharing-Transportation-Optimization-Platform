/** A place on the map, as coordinates. */
export interface MapPoint {
  latitude: number;
  longitude: number;
}

export interface MapViewProps {
  /** The place the person is heading to, when one has been picked. */
  destination: MapPoint | null;
  /** Where the device is, when the person has allowed it and it has been found. */
  currentLocation: MapPoint | null;
}

/**
 * - idle: nothing asked yet
 * - locating: waiting for the device
 * - ready: the location was found
 * - denied: the person (or their browser or phone settings) refused location access
 * - unavailable: location could not be found (no signal, no support, timed out)
 */
export type LocationStatus = 'idle' | 'locating' | 'ready' | 'denied' | 'unavailable';

export interface CurrentLocation {
  status: LocationStatus;
  /** The last location found, or null when there is none. */
  point: MapPoint | null;
  /** Asks for the device's location. Only ever called because the person asked for it. */
  locate: () => void;
}
