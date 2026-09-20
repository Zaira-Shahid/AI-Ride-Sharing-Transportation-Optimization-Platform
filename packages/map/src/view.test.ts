import { describe, expect, it } from 'vitest';
import { POINT_ZOOM, WORLD_CENTER, WORLD_ZOOM, frameMap } from './view';

const office = { latitude: 51.5049, longitude: -0.0195 };
const station = { latitude: 51.4494, longitude: -2.5813 };

describe('frameMap', () => {
  it('shows the whole world when there is nothing on the map', () => {
    expect(frameMap([])).toEqual({ kind: 'world', center: WORLD_CENTER, zoom: WORLD_ZOOM });
    expect(frameMap([null, null])).toEqual({
      kind: 'world',
      center: WORLD_CENTER,
      zoom: WORLD_ZOOM,
    });
  });

  it('closes in on a single point', () => {
    expect(frameMap([office, null])).toEqual({ kind: 'point', center: office, zoom: POINT_ZOOM });
    expect(frameMap([null, office])).toEqual({ kind: 'point', center: office, zoom: POINT_ZOOM });
  });

  it('treats two identical points as one', () => {
    expect(frameMap([office, { ...office }])).toEqual({
      kind: 'point',
      center: office,
      zoom: POINT_ZOOM,
    });
  });

  it('holds two points in the smallest box, whichever comes first', () => {
    const expected = {
      kind: 'bounds',
      southWest: { latitude: station.latitude, longitude: station.longitude },
      northEast: { latitude: office.latitude, longitude: office.longitude },
    };
    expect(frameMap([office, station])).toEqual(expected);
    expect(frameMap([station, office])).toEqual(expected);
  });

  it('holds points on either side of the equator and the prime meridian', () => {
    const framing = frameMap([
      { latitude: -10, longitude: -5 },
      { latitude: 10, longitude: 5 },
    ]);
    expect(framing).toEqual({
      kind: 'bounds',
      southWest: { latitude: -10, longitude: -5 },
      northEast: { latitude: 10, longitude: 5 },
    });
  });

  it('draws a plain box and does not wrap around the date line', () => {
    // Two points either side of the date line give the wide box, not the short way round. A trip
    // that crosses the date line is not expected, so this is a known limit rather than a case.
    const framing = frameMap([
      { latitude: 0, longitude: -170 },
      { latitude: 0, longitude: 170 },
    ]);
    expect(framing).toMatchObject({
      kind: 'bounds',
      southWest: { longitude: -170 },
      northEast: { longitude: 170 },
    });
  });
});
