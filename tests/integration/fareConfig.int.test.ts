import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FARE_CONFIG,
  FARE_CONFIG_PATH,
  readFareConfig,
} from '../../functions/src/fareConfig';
import { admin } from './support';

describe('readFareConfig (functions + firestore emulator)', () => {
  it('returns every default when config/fare does not exist', async () => {
    await admin().firestore.doc(FARE_CONFIG_PATH).delete();

    expect(await readFareConfig(admin().firestore)).toEqual(DEFAULT_FARE_CONFIG);
  });

  it('uses a real value where the document has one, and the default for everything else', async () => {
    await admin()
      .firestore.doc(FARE_CONFIG_PATH)
      .set({ baseFareMinorUnits: 300, platformFeePercent: 25 });

    expect(await readFareConfig(admin().firestore)).toEqual({
      ...DEFAULT_FARE_CONFIG,
      baseFareMinorUnits: 300,
      platformFeePercent: 25,
    });
  });

  it('falls back to the default for one field that is the wrong type, keeping the rest', async () => {
    await admin()
      .firestore.doc(FARE_CONFIG_PATH)
      .set({ perKmMinorUnits: 'a lot', perMinuteMinorUnits: 20 });

    expect(await readFareConfig(admin().firestore)).toEqual({
      ...DEFAULT_FARE_CONFIG,
      perMinuteMinorUnits: 20,
    });
  });
});
