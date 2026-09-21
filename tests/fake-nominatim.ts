import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { Socket } from 'node:net';

/**
 * The port the fake geocoder listens on. The emulators the tests start read where Nominatim is from
 * functions/.env.demo-ridemesh (NOMINATIM_BASE_URL), and tests/ports.test.ts checks that file names
 * this port, so nothing in a test can reach the real OpenStreetMap server.
 */
export const FAKE_NOMINATIM_PORT = 18_889;

export interface FakeRequest {
  latitude: number;
  longitude: number;
  headers: IncomingHttpHeaders;
  search: URLSearchParams;
}

export type FakeReply =
  | { kind: 'address'; body: unknown }
  | { kind: 'status'; status: number }
  | { kind: 'text'; text: string }
  | { kind: 'hang' };

export interface FakeNominatim {
  /** Every /reverse request received, in order. */
  requests: FakeRequest[];
  /** What to answer from now on; null goes back to the default, a street in Bristol built from the position. */
  reply: (reply: FakeReply | ((request: FakeRequest) => FakeReply) | null) => void;
  close: () => Promise<void>;
}

/** The answer given by default: one street address, which says where the request was for. */
export function defaultAddressBody(request: Pick<FakeRequest, 'latitude' | 'longitude'>) {
  return {
    display_name: 'Long name, Somewhere, England, United Kingdom',
    address: {
      house_number: '12',
      road: 'Test Street',
      suburb: 'Test Suburb',
      city: 'Bristol',
      county: 'Somerset',
      postcode: 'BS1 6QS',
      country: 'United Kingdom',
    },
    lat: String(request.latitude),
    lon: String(request.longitude),
  };
}

/**
 * The positions the end-to-end tests use to choose what the fake geocoder does, because the tests
 * run side by side and share one fake: an answer that depends on where the request is for cannot be
 * disturbed by another test. Every other position gets "no address", so a test that has nothing to do
 * with geocoding sees the same "Current location" it always did.
 */
export const E2E_GEOCODING = {
  /** Has an address: 12 Test Street, Bristol, BS1 6QS. */
  found: { latitude: 40, longitude: 10 },
  /** The provider fails (a 500). */
  failing: { latitude: 41, longitude: 10 },
} as const;

const near = (request: FakeRequest, place: { latitude: number; longitude: number }) =>
  Math.abs(request.latitude - place.latitude) < 0.001 &&
  Math.abs(request.longitude - place.longitude) < 0.001;

/** The answer the end-to-end tests' shared fake gives: by position (see E2E_GEOCODING). */
export function positionalReply(request: FakeRequest): FakeReply {
  if (near(request, E2E_GEOCODING.found)) {
    return { kind: 'address', body: defaultAddressBody(request) };
  }
  if (near(request, E2E_GEOCODING.failing)) return { kind: 'status', status: 500 };
  return { kind: 'address', body: { error: 'Unable to geocode' } };
}

/**
 * Starts a Nominatim stand-in on FAKE_NOMINATIM_PORT. By default it answers every request with a
 * street address; `defaultReply` changes that. Stop it with close().
 */
export async function startFakeNominatim(
  options: { defaultReply?: (request: FakeRequest) => FakeReply } = {},
): Promise<FakeNominatim> {
  const requests: FakeRequest[] = [];
  let current: FakeReply | ((request: FakeRequest) => FakeReply) | null =
    options.defaultReply ?? null;
  const fallback = options.defaultReply ?? null;
  const sockets = new Set<Socket>();

  const server: Server = createServer((incoming, response) => {
    const url = new URL(incoming.url ?? '/', `http://127.0.0.1:${FAKE_NOMINATIM_PORT}`);
    if (url.pathname !== '/reverse') {
      response.writeHead(404).end();
      return;
    }
    const request: FakeRequest = {
      latitude: Number(url.searchParams.get('lat')),
      longitude: Number(url.searchParams.get('lon')),
      headers: incoming.headers,
      search: url.searchParams,
    };
    requests.push(request);
    const reply: FakeReply =
      typeof current === 'function'
        ? current(request)
        : (current ?? { kind: 'address', body: defaultAddressBody(request) });
    if (reply.kind === 'hang') return; // never answers: the caller's timeout has to end it
    if (reply.kind === 'status') {
      response.writeHead(reply.status).end();
      return;
    }
    if (reply.kind === 'text') {
      response.writeHead(200, { 'content-type': 'text/plain' }).end(reply.text);
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(FAKE_NOMINATIM_PORT, '127.0.0.1', resolve);
  });

  return {
    requests,
    reply: (next) => {
      current = next ?? fallback;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
