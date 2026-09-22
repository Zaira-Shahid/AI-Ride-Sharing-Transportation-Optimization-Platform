import { afterEach, describe, expect, it, vi } from 'vitest';

const callable = vi.hoisted(() => ({
  bodies: [] as unknown[],
  names: [] as string[],
  answer: (() => Promise.resolve({ data: { status: 'found', route: null } })) as (
    data: unknown,
  ) => Promise<{ data: unknown }>,
}));

vi.mock('firebase/functions', () => ({
  httpsCallable: (_functions: unknown, name: string) => (data: unknown) => {
    callable.names.push(name);
    callable.bodies.push(data);
    return callable.answer(data);
  },
}));

const { calculateRoute } = await import('./routing');
const client = { functions: {} } as never;

const ROUTE = {
  distanceMeters: 1200,
  durationSeconds: 130,
  geometry: 'abc',
  legs: [{ distanceMeters: 1200, durationSeconds: 130 }],
};

afterEach(() => {
  callable.bodies.length = 0;
  callable.names.length = 0;
  callable.answer = () => Promise.resolve({ data: { status: 'found', route: null } });
});

describe('calculateRoute in the app', () => {
  it('rounds every stop to about 11 metres before it leaves the device', async () => {
    callable.answer = () => Promise.resolve({ data: { status: 'found', route: ROUTE } });

    const route = await calculateRoute(client, [
      { latitude: 51.44941234, longitude: -2.58139876 },
      { latitude: 51.50494321, longitude: -0.01949999 },
    ]);

    expect(route).toEqual(ROUTE);
    expect(callable.names).toEqual(['calculateRoute']);
    expect(callable.bodies).toEqual([
      {
        stops: [
          { latitude: 51.4494, longitude: -2.5814 },
          { latitude: 51.5049, longitude: -0.0195 },
        ],
      },
    ]);
    // The exact positions are nowhere in what was sent.
    const sent = JSON.stringify(callable.bodies);
    for (const exact of ['51.44941234', '2.58139876', '51.50494321', '0.01949999']) {
      expect(sent).not.toContain(exact);
    }
  });

  it('says nothing about the profile for a road route, and "walking" for a walk', async () => {
    const stops = [
      { latitude: 51.5049, longitude: -0.0195 },
      { latitude: 51.507, longitude: -0.025 },
    ];

    await calculateRoute(client, stops);
    await calculateRoute(client, stops, { profile: 'driving' });
    await calculateRoute(client, stops, { profile: 'walking' });

    const rounded = [
      { latitude: 51.5049, longitude: -0.0195 },
      { latitude: 51.507, longitude: -0.025 },
    ];
    expect(callable.bodies).toEqual([
      { stops: rounded },
      { stops: rounded },
      { stops: rounded, profile: 'walking' },
    ]);
  });

  it('does not change the stops it was given', async () => {
    const stops = [
      { latitude: 51.44941234, longitude: -2.58139876 },
      { latitude: 51.50494321, longitude: -0.01949999 },
    ];
    await calculateRoute(client, stops);
    expect(stops[0]?.latitude).toBe(51.44941234);
  });

  it.each([
    ['none', 'none'],
    ['unavailable', 'unavailable'],
    ['busy', 'busy'],
  ] as const)('returns null, without an error, when the server says %s', async (_label, status) => {
    callable.answer = () => Promise.resolve({ data: { status, route: null } });
    const outcomes: string[] = [];

    expect(
      await calculateRoute(
        client,
        [
          { latitude: 1, longitude: 1 },
          { latitude: 2, longitude: 2 },
        ],
        {
          onOutcome: (outcome) => outcomes.push(outcome),
        },
      ),
    ).toBeNull();
    expect(outcomes).toEqual([status]);
  });

  it('returns null when the call fails, and when it takes too long', async () => {
    callable.answer = () => Promise.reject(new Error('functions/internal'));
    const outcomes: string[] = [];
    const stops = [
      { latitude: 1, longitude: 1 },
      { latitude: 2, longitude: 2 },
    ];
    expect(await calculateRoute(client, stops, { onOutcome: (o) => outcomes.push(o) })).toBeNull();

    callable.answer = () => new Promise(() => undefined);
    const started = Date.now();
    expect(
      await calculateRoute(client, stops, { waitMs: 40, onOutcome: (o) => outcomes.push(o) }),
    ).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(outcomes).toEqual(['failed', 'failed']);
  });
});
