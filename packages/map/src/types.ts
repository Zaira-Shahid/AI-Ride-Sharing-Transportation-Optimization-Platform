/** A place on the map, as coordinates. */
export interface MapPoint {
  latitude: number;
  longitude: number;
}

export interface MapViewProps {
  /** Where the person will be picked up, when it has been chosen. */
  pickup: MapPoint | null;
  /** The place the person is heading to, when one has been picked. */
  destination: MapPoint | null;
  /** Where the device is, when the person has allowed it and it has been found. */
  currentLocation: MapPoint | null;
  /**
   * How much of the map, in pixels, is covered at the top and the bottom by things drawn over it
   * (the search and the buttons). Places are framed in the part that is left, and the zoom buttons
   * are kept out of the covered part. Defaults to nothing covered.
   */
  insets?: MapInsets;
}

export interface MapInsets {
  top: number;
  bottom: number;
}

/**
 * - idle: nothing asked yet
 * - locating: waiting for the device
 * - ready: the location was found
 * - denied: the person (or their browser or phone settings) refused location access
 * - unavailable: location could not be found (no signal, no support, timed out)
 */
export type LocationStatus = 'idle' | 'locating' | 'ready' | 'denied' | 'unavailable';

export interface LocateOptions {
  /**
   * The oldest reading, in ms, that is good enough (web only: phones always read afresh). The default
   * is a minute, which suits showing where the person is on a map; use 0 when the position is going
   * to be saved, so that what is saved is where the device is now.
   */
  maxAgeMs?: number;
}

export interface CurrentLocation {
  status: LocationStatus;
  /** The last location found, or null when there is none. */
  point: MapPoint | null;
  /** Asks for the device's location. Only ever called because the person asked for it. */
  locate: () => void;
}

/**
 * - idle: not following (the driver is offline)
 * - starting: waiting for permission or the first reading
 * - watching: readings are arriving
 * - denied: the person (or their browser or phone settings) refused location access
 * - unavailable: the location cannot be read (no signal, no support)
 */
export type LocationWatchStatus = 'idle' | 'starting' | 'watching' | 'denied' | 'unavailable';

/** One reading of the device's position while it is being followed. */
export interface LocationReading {
  latitude: number;
  longitude: number;
  /** The radius of the uncertainty in metres, or null when the device does not say. */
  accuracy: number | null;
  /** When the reading was taken, in ms since 1970. */
  at: number;
}

export interface LocationWatch {
  status: LocationWatchStatus;
}
