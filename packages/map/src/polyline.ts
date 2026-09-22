import type { MapPoint } from './types';

/**
 * Decodes a route's line (Module 4.7) from the encoded polyline format OSRM (and Google) return:
 * latitude and longitude as a running total, each step packed into base-64-like characters. Five
 * decimal places, the format's usual precision, is what OSRM and the server (`functions/src/routing.ts`)
 * both use. This is the standard published algorithm, not something of our own, so no drawing
 * library needs to know the encoding either.
 */
export function decodePolyline(encoded: string): MapPoint[] {
  const points: MapPoint[] = [];
  let index = 0;
  let latitude = 0;
  let longitude = 0;

  const readValue = (): number => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index) - 63;
      index += 1;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };

  while (index < encoded.length) {
    latitude += readValue();
    longitude += readValue();
    points.push({ latitude: latitude / 1e5, longitude: longitude / 1e5 });
  }

  return points;
}
