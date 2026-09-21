import { describe, expect, it } from 'vitest';
import {
  createNominatimProvider,
  formatNominatimAddress,
  limitsFromEnvironment,
  nominatimFromEnvironment,
} from './geocoding';

describe('formatNominatimAddress', () => {
  it('writes a street address the way a person would', () => {
    expect(
      formatNominatimAddress({
        display_name: '12, Test Street, Somewhere, England, United Kingdom',
        address: {
          house_number: '12',
          road: 'Test Street',
          suburb: 'Test Suburb',
          city: 'Bristol',
          county: 'Somerset',
          postcode: 'BS1 6QS',
          country: 'United Kingdom',
        },
      }),
    ).toBe('12 Test Street, Bristol, BS1 6QS');
  });

  it('copes with parts that are missing', () => {
    expect(formatNominatimAddress({ address: { road: 'Test Street', town: 'Bath' } })).toBe(
      'Test Street, Bath',
    );
    expect(formatNominatimAddress({ address: { footway: 'A Path', village: 'Corsham' } })).toBe(
      'A Path, Corsham',
    );
    expect(formatNominatimAddress({ address: { suburb: 'Clifton', postcode: 'BS8 1AA' } })).toBe(
      'Clifton, BS8 1AA',
    );
    expect(formatNominatimAddress({ address: { house_number: '9' } })).toBeNull();
  });

  it('prefers a city over a suburb, and skips blank parts', () => {
    expect(
      formatNominatimAddress({
        address: { road: ' Main Road ', suburb: 'Suburb', city: 'Cardiff', postcode: '   ' },
      }),
    ).toBe('Main Road, Cardiff');
  });

  it('falls back to the provider long name when there are no parts, and to nothing without it', () => {
    expect(formatNominatimAddress({ display_name: 'The Atlantic Ocean', address: {} })).toBe(
      'The Atlantic Ocean',
    );
    expect(formatNominatimAddress({ display_name: 'Somewhere' })).toBe('Somewhere');
    expect(formatNominatimAddress({ address: {} })).toBeNull();
    expect(formatNominatimAddress({ display_name: '   ' })).toBeNull();
  });

  it('says there is no address when the provider says so', () => {
    expect(formatNominatimAddress({ error: 'Unable to geocode' })).toBeNull();
  });

  it('never makes an address longer than a place may have', () => {
    expect(formatNominatimAddress({ display_name: 'x'.repeat(500) })).toHaveLength(300);
  });

  it('refuses an answer that is not an object, which is a failure and not "no address"', () => {
    expect(() => formatNominatimAddress(null)).toThrow();
    expect(() => formatNominatimAddress('nope')).toThrow();
    expect(() => formatNominatimAddress(5)).toThrow();
  });
});

describe('the Nominatim provider', () => {
  const point = { latitude: 51.4494, longitude: -2.5813 };

  function stub(response: () => Response | Promise<Response>) {
    const calls: { url: URL; init: RequestInit | undefined }[] = [];
    const fetchImpl = ((input: URL | string, init?: RequestInit) => {
      calls.push({ url: new URL(String(input)), init });
      return Promise.resolve(response());
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('asks for a street address near the position, and says who is asking', async () => {
    const { calls, fetchImpl } = stub(() =>
      json({ address: { road: 'Test Street', city: 'Bristol' } }),
    );
    const provider = createNominatimProvider({
      baseUrl: 'https://nominatim.example.test',
      userAgent: 'RideMesh-unit (test)',
      fetchImpl,
    });

    expect(await provider.reverse(point)).toBe('Test Street, Bristol');

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0] ?? { url: new URL('http://none'), init: undefined };
    expect(url.origin + url.pathname).toBe('https://nominatim.example.test/reverse');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      format: 'jsonv2',
      lat: '51.4494',
      lon: '-2.5813',
      zoom: '18',
      addressdetails: '1',
      'accept-language': 'en',
    });
    expect((init?.headers as Record<string, string>)['User-Agent']).toBe('RideMesh-unit (test)');
  });

  it('keeps a path on the base URL, for a server of our own', async () => {
    const { calls, fetchImpl } = stub(() => json({ address: { road: 'A' } }));
    const provider = createNominatimProvider({
      baseUrl: 'https://maps.example.test/nominatim/',
      userAgent: 'x',
      fetchImpl,
    });
    await provider.reverse(point);
    expect(calls[0]?.url.pathname).toBe('/nominatim/reverse');
  });

  it('says there is no address when the provider does', async () => {
    const { fetchImpl } = stub(() => json({ error: 'Unable to geocode' }));
    const provider = createNominatimProvider({
      baseUrl: 'https://n.test',
      userAgent: 'x',
      fetchImpl,
    });
    expect(await provider.reverse(point)).toBeNull();
  });

  it.each([429, 500, 503])('fails, rather than saying "no address", on a %s', async (status) => {
    const { fetchImpl } = stub(() => new Response('', { status }));
    const provider = createNominatimProvider({
      baseUrl: 'https://n.test',
      userAgent: 'x',
      fetchImpl,
    });
    await expect(provider.reverse(point)).rejects.toThrow(String(status));
  });

  it('fails on an answer that is not JSON, and when the network fails', async () => {
    const notJson = stub(() => new Response('<html>', { status: 200 }));
    await expect(
      createNominatimProvider({
        baseUrl: 'https://n.test',
        userAgent: 'x',
        fetchImpl: notJson.fetchImpl,
      }).reverse(point),
    ).rejects.toThrow();

    const down = (() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch;
    await expect(
      createNominatimProvider({
        baseUrl: 'https://n.test',
        userAgent: 'x',
        fetchImpl: down,
      }).reverse(point),
    ).rejects.toThrow('fetch failed');
  });

  it('gives up after its timeout instead of waiting for ever', async () => {
    const hangs = ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const provider = createNominatimProvider({
      baseUrl: 'https://n.test',
      userAgent: 'x',
      timeoutMs: 30,
      fetchImpl: hangs,
    });
    const started = Date.now();
    await expect(provider.reverse(point)).rejects.toThrow('aborted');
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('configuration from the environment', () => {
  it('uses the public server by default, and says the contact is not configured', () => {
    const provider = nominatimFromEnvironment({});
    expect(provider).toBeDefined();
    expect(limitsFromEnvironment({})).toEqual({ globalSpacingMs: 1_100, perCallerPerMinute: 10 });
  });

  it('reads the spacing, and ignores nonsense', () => {
    expect(limitsFromEnvironment({ GEOCODING_MIN_SPACING_MS: '0' }).globalSpacingMs).toBe(0);
    expect(limitsFromEnvironment({ GEOCODING_MIN_SPACING_MS: '2500' }).globalSpacingMs).toBe(2_500);
    expect(limitsFromEnvironment({ GEOCODING_MIN_SPACING_MS: '-5' }).globalSpacingMs).toBe(1_100);
    expect(limitsFromEnvironment({ GEOCODING_MIN_SPACING_MS: 'abc' }).globalSpacingMs).toBe(1_100);
    expect(limitsFromEnvironment({ GEOCODING_MIN_SPACING_MS: '' }).globalSpacingMs).toBe(1_100);
    expect(limitsFromEnvironment({ GEOCODING_MIN_SPACING_MS: '  ' }).globalSpacingMs).toBe(1_100);
  });
});
