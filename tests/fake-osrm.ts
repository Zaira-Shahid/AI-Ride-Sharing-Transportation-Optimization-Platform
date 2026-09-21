import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { Socket } from 'node:net';

/**
 * The port the fake route server listens on. The emulators the tests start read where OSRM is from
 * functions/.env.demo-ridemesh (ROUTING_BASE_URL_DRIVING), and tests/ports.test.ts checks that file
 * names this port, so nothing in a test can reach the real routing server.
 */
export const FAKE_OSRM_PORT = 18_890;
/** The path the fake serves under, like the community server's car profile (routed-car). */
export const FAKE_OSRM_BASE_PATH = '/routed-car';

export interface FakeStop {
  latitude: number;
  longitude: number;
}

export interface FakeRouteRequest {
  stops: FakeStop[];
  path: string;
  headers: IncomingHttpHeaders;
  search: URLSearchParams;
}

export type FakeRouteReply =
  | { kind: 'route'; body: unknown }
  | { kind: 'status'; status: number; body?: unknown }
  | { kind: 'text'; text: string }
  | { kind: 'hang' };

export interface FakeOsrm {
  /** Every route request received, in order. */
  requests: FakeRouteRequest[];
  /** What to answer from now on; null goes back to the default route built from the stops. */
  reply: (reply: FakeRouteReply | ((request: FakeRouteRequest) => FakeRouteReply) | null) => void;
  close: () => Promise<void>;
}

/** Google's encoded polyline format, 5 decimals: what OSRM returns for geometries=polyline. */
export function encodePolyline(points: readonly FakeStop[]): string {
  let previousLatitude = 0;
  let previousLongitude = 0;
  const encodeNumber = (value: number) => {
    let rest = value < 0 ? ~(value << 1) : value << 1;
    let out = '';
    while (rest >= 0x20) {
      out += String.fromCharCode((0x20 | (rest & 0x1f)) + 63);
      rest >>= 5;
    }
    return out + String.fromCharCode(rest + 63);
  };
  let encoded = '';
  for (const point of points) {
    const latitude = Math.round(point.latitude * 1e5);
    const longitude = Math.round(point.longitude * 1e5);
    encoded +=
      encodeNumber(latitude - previousLatitude) + encodeNumber(longitude - previousLongitude);
    previousLatitude = latitude;
    previousLongitude = longitude;
  }
  return encoded;
}

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
function metresBetween(a: FakeStop, b: FakeStop): number {
  const dLatitude = toRadians(b.latitude - a.latitude);
  const dLongitude = toRadians(b.longitude - a.longitude);
  const h =
    Math.sin(dLatitude / 2) ** 2 +
    Math.cos(toRadians(a.latitude)) *
      Math.cos(toRadians(b.latitude)) *
      Math.sin(dLongitude / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * An answer shaped like the real one (checked once against routing.openstreetmap.de): code Ok, one
 * route with a leg between each two stops, a line, and each stop put on a road a few metres away.
 * The road is 1.3 times the straight line and travelled at 50 km/h, so the numbers say what the
 * request was for.
 */
export function defaultRouteBody(
  request: Pick<FakeRouteRequest, 'stops'>,
  options: { snapMeters?: number } = {},
) {
  const legs = request.stops.slice(1).map((stop, index) => {
    const distance =
      Math.round(metresBetween(request.stops[index] as FakeStop, stop) * 1.3 * 10) / 10;
    return { steps: [], weight: distance / 13.9, summary: '', duration: distance / 13.9, distance };
  });
  const distance = legs.reduce((sum, leg) => sum + leg.distance, 0);
  const duration = legs.reduce((sum, leg) => sum + leg.duration, 0);
  return {
    code: 'Ok',
    routes: [
      {
        legs,
        weight_name: 'routability',
        geometry: encodePolyline(request.stops),
        weight: duration,
        duration,
        distance,
      },
    ],
    waypoints: request.stops.map((stop) => ({
      hint: 'fake',
      location: [stop.longitude, stop.latitude],
      name: '',
      distance: options.snapMeters ?? 5.5,
    })),
  };
}

/** Starts an OSRM stand-in on FAKE_OSRM_PORT. Stop it with close(). */
export async function startFakeOsrm(): Promise<FakeOsrm> {
  const requests: FakeRouteRequest[] = [];
  let current: FakeRouteReply | ((request: FakeRouteRequest) => FakeRouteReply) | null = null;
  const sockets = new Set<Socket>();

  const server: Server = createServer((incoming, response) => {
    const url = new URL(incoming.url ?? '/', `http://127.0.0.1:${FAKE_OSRM_PORT}`);
    const prefix = `${FAKE_OSRM_BASE_PATH}/route/v1/driving/`;
    if (!url.pathname.startsWith(prefix)) {
      response.writeHead(404).end();
      return;
    }
    const stops: FakeStop[] = decodeURIComponent(url.pathname.slice(prefix.length))
      .split(';')
      .map((pair) => {
        const [longitude, latitude] = pair.split(',').map(Number);
        return { latitude: latitude as number, longitude: longitude as number };
      });
    const request: FakeRouteRequest = {
      stops,
      path: url.pathname,
      headers: incoming.headers,
      search: url.searchParams,
    };
    requests.push(request);
    const reply: FakeRouteReply =
      typeof current === 'function'
        ? current(request)
        : (current ?? { kind: 'route', body: defaultRouteBody(request) });
    if (reply.kind === 'hang') return; // never answers: the caller's timeout has to end it
    if (reply.kind === 'status') {
      response
        .writeHead(reply.status, { 'content-type': 'application/json' })
        .end(reply.body === undefined ? undefined : JSON.stringify(reply.body));
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
    server.listen(FAKE_OSRM_PORT, '127.0.0.1', resolve);
  });

  return {
    requests,
    reply: (next) => {
      current = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
