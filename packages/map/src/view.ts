import type { MapPoint } from './types';

/** What the map should show, worked out from the points on it. */
export type MapFraming =
  /** No points: the whole world. */
  | { kind: 'world'; center: MapPoint; zoom: number }
  /** One point: close in on it. */
  | { kind: 'point'; center: MapPoint; zoom: number }
  /** Several points: the smallest box that holds them all. */
  | { kind: 'bounds'; southWest: MapPoint; northEast: MapPoint };

export const WORLD_CENTER: MapPoint = { latitude: 20, longitude: 0 };
export const WORLD_ZOOM = 2;
/** Street level: close enough to see where the place is. */
export const POINT_ZOOM = 15;

/**
 * Works out how the map should be framed for the given points (a destination, the device's
 * location, or both). Kept apart from the map libraries so it is the same on every platform.
 */
export function frameMap(points: readonly (MapPoint | null)[]): MapFraming {
  const present = points.filter((point): point is MapPoint => point !== null);
  const first = present[0];
  if (!first) return { kind: 'world', center: WORLD_CENTER, zoom: WORLD_ZOOM };

  const latitudes = present.map((point) => point.latitude);
  const longitudes = present.map((point) => point.longitude);
  const south = Math.min(...latitudes);
  const north = Math.max(...latitudes);
  const west = Math.min(...longitudes);
  const east = Math.max(...longitudes);
  if (south === north && west === east) return { kind: 'point', center: first, zoom: POINT_ZOOM };

  return {
    kind: 'bounds',
    southWest: { latitude: south, longitude: west },
    northEast: { latitude: north, longitude: east },
  };
}
