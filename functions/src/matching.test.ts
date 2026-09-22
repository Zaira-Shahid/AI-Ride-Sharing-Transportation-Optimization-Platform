import { describe, expect, it } from 'vitest';
import {
  bearingDegrees,
  bearingDifferenceDegrees,
  CANDIDATE_DIRECTION_TOLERANCE_DEGREES,
  CANDIDATE_PROXIMITY_METERS,
  findCandidateJourneys,
  isLeaveNowRequest,
  type CandidateSourceJourney,
} from './matching';

// Roughly a Bristol -> London corridor, to keep coordinates in the same ballpark as routing.test.ts.
const PICKUP = { latitude: 51.4545, longitude: -2.5879 };
const DESTINATION = { latitude: 51.5074, longitude: -0.1278 };

function journey(overrides: Partial<CandidateSourceJourney> = {}): CandidateSourceJourney {
  return {
    id: 'journey-1',
    driverId: 'driver-1',
    origin: { latitude: 51.46, longitude: -2.58 },
    destination: DESTINATION,
    availableSeats: 2,
    ...overrides,
  };
}

describe('bearingDegrees', () => {
  it('reads due east as 90 and due south as 180', () => {
    expect(
      bearingDegrees({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 }),
    ).toBeCloseTo(90, 0);
    expect(
      bearingDegrees({ latitude: 1, longitude: 0 }, { latitude: 0, longitude: 0 }),
    ).toBeCloseTo(180, 0);
  });
});

describe('bearingDifferenceDegrees', () => {
  it('is the smaller angle either way round the compass', () => {
    expect(bearingDifferenceDegrees(10, 20)).toBe(10);
    expect(bearingDifferenceDegrees(350, 10)).toBe(20);
    expect(bearingDifferenceDegrees(0, 180)).toBe(180);
  });
});

describe('findCandidateJourneys', () => {
  it('accepts a nearby journey heading the same way, closest first', () => {
    const near = journey({ id: 'near', origin: { latitude: 51.456, longitude: -2.585 } });
    const far = journey({
      id: 'far',
      origin: { latitude: 51.465, longitude: -2.56 },
      destination: DESTINATION,
    });

    const candidates = findCandidateJourneys({ origin: PICKUP, destination: DESTINATION }, [
      far,
      near,
    ]);

    expect(candidates.map((c) => c.journeyId)).toEqual(['near', 'far']);
    expect(candidates[0]?.driverId).toBe('driver-1');
    expect(candidates.every((c) => c.distanceMeters <= CANDIDATE_PROXIMITY_METERS)).toBe(true);
    expect(
      candidates.every((c) => c.bearingDifferenceDegrees <= CANDIDATE_DIRECTION_TOLERANCE_DEGREES),
    ).toBe(true);
  });

  it('rejects a journey too far from the pickup', () => {
    const far = journey({ origin: { latitude: 52.5, longitude: -1.9 } });
    expect(findCandidateJourneys({ origin: PICKUP, destination: DESTINATION }, [far])).toEqual([]);
  });

  it('rejects a journey heading the wrong way', () => {
    const backwards = journey({
      origin: { latitude: 51.46, longitude: -2.58 },
      destination: { latitude: 51.42, longitude: -2.65 },
    });
    expect(
      findCandidateJourneys({ origin: PICKUP, destination: DESTINATION }, [backwards]),
    ).toEqual([]);
  });

  it('rejects a journey with no seats left', () => {
    const full = journey({ availableSeats: 0 });
    expect(findCandidateJourneys({ origin: PICKUP, destination: DESTINATION }, [full])).toEqual([]);
    const none = journey({ availableSeats: null });
    expect(findCandidateJourneys({ origin: PICKUP, destination: DESTINATION }, [none])).toEqual([]);
  });

  it('skips a journey with no origin or no destination', () => {
    const noOrigin = journey({ origin: null });
    const noDestination = journey({ destination: null });
    expect(
      findCandidateJourneys({ origin: PICKUP, destination: DESTINATION }, [
        noOrigin,
        noDestination,
      ]),
    ).toEqual([]);
  });
});

describe('isLeaveNowRequest', () => {
  const at = (ms: number) => ({ toMillis: () => ms });

  it('is true when the request and departure instants are the same', () => {
    expect(isLeaveNowRequest({ requestedAt: at(1_000), requestedDepartureTime: at(1_000) })).toBe(
      true,
    );
  });

  it('is false for a chosen future departure, or when either instant is missing', () => {
    expect(isLeaveNowRequest({ requestedAt: at(1_000), requestedDepartureTime: at(2_000) })).toBe(
      false,
    );
    expect(isLeaveNowRequest({ requestedAt: null, requestedDepartureTime: at(1_000) })).toBe(false);
    expect(isLeaveNowRequest({ requestedAt: at(1_000), requestedDepartureTime: undefined })).toBe(
      false,
    );
  });
});
