import { describe, expect, it } from 'vitest';
import { DESTINATION_ADDRESS_MAX_LENGTH, PLACE_ID_MAX_LENGTH } from './journey';
import {
  CURRENT_LOCATION_ADDRESS,
  SAME_PLACE_DISTANCE_METERS,
  checkChosenPlace,
  findPlaceProblem,
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

describe('findPlaceProblem', () => {
  it('accepts a place with coordinates, an address and a place ID, or without a place ID', () => {
    expect(findPlaceProblem(office)).toBeNull();
    expect(findPlaceProblem({ ...office, placeId: null })).toBeNull();
    expect(findPlaceProblem(currentLocationPlace(office))).toBeNull();
  });

  it('accepts the edges of the range, and places anywhere in the world', () => {
    expect(findPlaceProblem({ ...office, latitude: 90, longitude: 180 })).toBeNull();
    expect(findPlaceProblem({ ...office, latitude: -90, longitude: -180 })).toBeNull();
    // A single zero is a real place (the equator, the prime meridian); only both together are not.
    expect(findPlaceProblem({ ...office, latitude: 0, longitude: 10 })).toBeNull();
    expect(findPlaceProblem({ ...office, latitude: 10, longitude: 0 })).toBeNull();
    // There is no service area: places on other continents are fine.
    expect(findPlaceProblem({ ...office, latitude: -33.87, longitude: 151.21 })).toBeNull();
  });

  it.each([
    ['a latitude above 90', { latitude: 90.0001 }],
    ['a latitude below -90', { latitude: -91 }],
    ['a longitude above 180', { longitude: 181 }],
    ['a longitude below -180', { longitude: -180.5 }],
    ['not a number', { latitude: Number.NaN }],
    ['infinity', { longitude: Number.POSITIVE_INFINITY }],
    ['a missing latitude', { latitude: undefined as unknown as number }],
    ['text as a longitude', { longitude: '0.1' as unknown as number }],
  ])('refuses %s as bad coordinates', (_label, change) => {
    expect(findPlaceProblem({ ...office, ...change })).toBe('BAD_COORDINATES');
  });

  it('refuses exactly 0, 0 as no position', () => {
    expect(findPlaceProblem({ ...office, latitude: 0, longitude: 0 })).toBe('NO_POSITION');
    expect(findPlaceProblem({ ...office, latitude: -0, longitude: 0 })).toBe('NO_POSITION');
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['too long', 'x'.repeat(DESTINATION_ADDRESS_MAX_LENGTH + 1)],
    ['not text', 12 as unknown as string],
  ])('refuses an address that is %s', (_label, formattedAddress) => {
    expect(findPlaceProblem({ ...office, formattedAddress })).toBe('BAD_ADDRESS');
  });

  it('accepts an address at the length limit', () => {
    const formattedAddress = 'x'.repeat(DESTINATION_ADDRESS_MAX_LENGTH);
    expect(findPlaceProblem({ ...office, formattedAddress })).toBeNull();
  });

  it.each([
    ['empty', ''],
    ['blank', '  '],
    ['too long', 'p'.repeat(PLACE_ID_MAX_LENGTH + 1)],
    ['not text', 7 as unknown as string],
  ])('refuses a place ID that is %s', (_label, placeId) => {
    expect(findPlaceProblem({ ...office, placeId })).toBe('BAD_PLACE_ID');
  });

  it('reports the coordinates first when several things are wrong', () => {
    expect(findPlaceProblem({ ...office, latitude: 200, formattedAddress: '' })).toBe(
      'BAD_COORDINATES',
    );
    expect(findPlaceProblem({ ...office, latitude: 0, longitude: 0, formattedAddress: '' })).toBe(
      'NO_POSITION',
    );
  });
});

describe('checkChosenPlace', () => {
  const station = {
    latitude: 51.4494,
    longitude: -2.5813,
    formattedAddress: 'Temple Meads, Bristol BS1 6QS, UK',
    placeId: 'place-station',
  };

  it('accepts a usable place when nothing else is chosen yet, or the other is far away', () => {
    expect(checkChosenPlace(office, null)).toBeNull();
    expect(checkChosenPlace(office, station)).toBeNull();
    expect(checkChosenPlace(station, office)).toBeNull();
  });

  it('refuses a place that cannot be used, before it looks at the other place', () => {
    expect(checkChosenPlace({ ...office, latitude: 0, longitude: 0 }, null)).toBe('UNUSABLE');
    expect(checkChosenPlace({ ...office, formattedAddress: '' }, station)).toBe('UNUSABLE');
    // Unusable even though it is also the same place as the other.
    expect(checkChosenPlace({ ...office, formattedAddress: '' }, office)).toBe('UNUSABLE');
  });

  it('refuses the same place as the other, by place ID or by distance', () => {
    expect(checkChosenPlace(office, { ...office })).toBe('SAME_AS_OTHER');
    expect(checkChosenPlace(northOfOffice(20, 'other'), office)).toBe('SAME_AS_OTHER');
    expect(checkChosenPlace(currentLocationPlace(office), office)).toBe('SAME_AS_OTHER');
    expect(checkChosenPlace(northOfOffice(90, 'other'), office)).toBeNull();
  });
});
