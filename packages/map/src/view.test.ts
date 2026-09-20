import { describe, expect, it } from 'vitest';
import {
  MIN_FREE_MAP_PX,
  POINT_ZOOM,
  WORLD_CENTER,
  WORLD_ZOOM,
  clampInsets,
  frameMap,
  frameMargin,
} from './view';

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

describe('clampInsets', () => {
  it('leaves covers alone when enough of the map is still free', () => {
    expect(clampInsets({ top: 300, bottom: 100 }, 726)).toEqual({ top: 300, bottom: 100 });
    expect(clampInsets({ top: 0, bottom: 0 }, 726)).toEqual({ top: 0, bottom: 0 });
  });

  it('allows covers up to the point where the minimum is left free', () => {
    const room = 726 - MIN_FREE_MAP_PX;
    expect(clampInsets({ top: room - 100, bottom: 100 }, 726)).toEqual({
      top: room - 100,
      bottom: 100,
    });
  });

  it('shrinks both covers in proportion when they cover too much, keeping the minimum free', () => {
    const clamped = clampInsets({ top: 567, bottom: 107 }, 726);
    expect(726 - clamped.top - clamped.bottom).toBeCloseTo(MIN_FREE_MAP_PX, 6);
    // In proportion: the top cover is still about 5.3 times the bottom one.
    expect(clamped.top / clamped.bottom).toBeCloseTo(567 / 107, 6);
  });

  it('copes with a map smaller than the minimum, and with a map that has no height yet', () => {
    expect(clampInsets({ top: 50, bottom: 50 }, 100)).toEqual({ top: 0, bottom: 0 });
    expect(clampInsets({ top: 50, bottom: 50 }, 0)).toEqual({ top: 0, bottom: 0 });
  });
});

describe('frameMargin', () => {
  it('is 32 px, and smaller when the free part of the map is small', () => {
    expect(frameMargin(500)).toBe(32);
    expect(frameMargin(128)).toBe(32);
    expect(frameMargin(100)).toBe(25);
    expect(frameMargin(0)).toBe(0);
    expect(frameMargin(-20)).toBe(0);
  });
});
