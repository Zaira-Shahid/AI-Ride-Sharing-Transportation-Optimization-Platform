import { describe, expect, it } from 'vitest';
import {
  CURRENT_LOCATION_ADDRESS,
  SAME_PLACE_DISTANCE_METERS,
  currentLocationPlace,
  distanceMeters,
  isSamePlace,
} from './trip';

const office = {
  latitude: 51.5049,
  longitude: -0.0195,
  formattedAddress: '1 Canada Square, London E14 5AB, UK',
  placeId: 'place-office',
};

/** A place this many metres due north of the office (one degree of latitude is about 111.2 km). */
const northOfOffice = (meters: number, placeId: string | null = null) => ({
  ...office,
  latitude: office.latitude + meters / 111_195,
  formattedAddress: 'Somewhere else',
  placeId,
});

describe('distanceMeters', () => {
  it('is zero for the same point, and the same both ways round', () => {
    expect(distanceMeters(office, office)).toBe(0);
    const station = { latitude: 51.4494, longitude: -2.5813 };
    expect(distanceMeters(office, station)).toBeCloseTo(distanceMeters(station, office), 6);
  });

  it('measures a known distance: Canary Wharf to Bristol Temple Meads is about 177.5 km', () => {
    // Worked by hand: 0.0555 degrees of latitude is 6.2 km, and 2.5618 degrees of longitude at
    // latitude 51.5 is 2.5618 x 111.2 x cos(51.5) = 177.4 km; together about 177.5 km.
    const km = distanceMeters(office, { latitude: 51.4494, longitude: -2.5813 }) / 1000;
    expect(km).toBeGreaterThan(177);
    expect(km).toBeLessThan(178);
  });

  it('measures short distances, in metres', () => {
    expect(distanceMeters(office, northOfOffice(100))).toBeCloseTo(100, 0);
    expect(distanceMeters(office, northOfOffice(22))).toBeCloseTo(22, 0);
  });

  it('measures across the equator, the prime meridian and the poles without going wrong', () => {
    expect(
      distanceMeters({ latitude: -0.0005, longitude: 0 }, { latitude: 0.0005, longitude: 0 }),
    ).toBeCloseTo(111.2, 0);
    expect(
      distanceMeters({ latitude: 90, longitude: 0 }, { latitude: 90, longitude: 180 }),
    ).toBeCloseTo(0, 3);
    expect(
      distanceMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 180 }) / 1000,
    ).toBeCloseTo(20015, -1);
  });
});

describe('isSamePlace', () => {
  it('counts the same place ID as the same place, however far apart the coordinates say', () => {
    expect(isSamePlace(office, { ...office })).toBe(true);
    expect(isSamePlace(office, { ...northOfOffice(5000, 'place-office') })).toBe(true);
  });

  it('counts places closer than the limit as the same place, with or without an ID', () => {
    expect(isSamePlace(office, northOfOffice(20, 'place-other'))).toBe(true);
    expect(isSamePlace(office, northOfOffice(49, null))).toBe(true);
    expect(isSamePlace(currentLocationPlace(office), office)).toBe(true);
  });

  it('keeps places at or beyond the limit apart', () => {
    expect(SAME_PLACE_DISTANCE_METERS).toBe(50);
    expect(isSamePlace(office, northOfOffice(51, 'place-other'))).toBe(false);
    expect(isSamePlace(office, northOfOffice(90, null))).toBe(false);
    expect(
      isSamePlace(office, { ...office, latitude: 51.4494, longitude: -2.5813, placeId: 'p2' }),
    ).toBe(false);
  });

  it('does not treat two missing IDs as the same ID', () => {
    const one = { ...northOfOffice(200, null) };
    const two = { ...northOfOffice(400, null) };
    expect(isSamePlace(one, two)).toBe(false);
    expect(isSamePlace({ ...one, placeId: '' }, { ...two, placeId: '' })).toBe(false);
  });

  it('is symmetric', () => {
    const near = northOfOffice(30, 'x');
    const far = northOfOffice(300, 'y');
    expect(isSamePlace(office, near)).toBe(isSamePlace(near, office));
    expect(isSamePlace(office, far)).toBe(isSamePlace(far, office));
  });
});

describe('currentLocationPlace', () => {
  it('has the coordinates, a plain name and no place ID', () => {
    expect(currentLocationPlace({ latitude: 51.4494, longitude: -2.5813 })).toEqual({
      latitude: 51.4494,
      longitude: -2.5813,
      formattedAddress: CURRENT_LOCATION_ADDRESS,
      placeId: null,
    });
    expect(CURRENT_LOCATION_ADDRESS).toBe('Current location');
  });
});
