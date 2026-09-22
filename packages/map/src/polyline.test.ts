import { describe, expect, it } from 'vitest';
import { decodePolyline } from './polyline';

describe('decodePolyline', () => {
  it("decodes the format's own published example", () => {
    // From the encoded polyline algorithm's own documentation: three points, five decimal places.
    const points = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(points).toEqual([
      { latitude: 38.5, longitude: -120.2 },
      { latitude: 40.7, longitude: -120.95 },
      { latitude: 43.252, longitude: -126.453 },
    ]);
  });

  it('decodes nothing from an empty line', () => {
    expect(decodePolyline('')).toEqual([]);
  });

  it('decodes a single point', () => {
    // One degree north and two degrees east of the origin, at 5 decimal places.
    expect(decodePolyline('_ibE_seK')).toEqual([{ latitude: 1, longitude: 2 }]);
  });
});
