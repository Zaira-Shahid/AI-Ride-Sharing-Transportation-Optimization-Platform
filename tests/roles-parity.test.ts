import {
  SELF_SERVICE_ROLES as functionsSelfService,
  STAFF_ROLES as functionsStaff,
  USER_STATUSES as functionsStatuses,
} from '../functions/src/roles';
import { NEW_DRIVER_PROFILE_DEFAULTS as functionsDriverDefaults } from '../functions/src/drivers';
import {
  NEW_VEHICLE_DEFAULTS as functionsVehicleDefaults,
  VEHICLE_TYPES as functionsVehicleTypes,
  isValidPlate as functionsIsValidPlate,
  normalizePlate as functionsNormalizePlate,
  saveVehicleInputSchema as functionsVehicleSchema,
} from '../functions/src/vehicles';
import {
  DRIVER_AVAILABILITY_STATUSES,
  DRIVER_VERIFICATION_STATUSES,
  NEW_DRIVER_PROFILE_DEFAULTS,
  NEW_VEHICLE_DEFAULTS,
  VEHICLE_TYPES,
  VEHICLE_VERIFICATION_STATUSES,
  isValidPlate,
  normalizePlate,
  saveVehicleInputSchema as sharedVehicleSchema,
  SELF_SERVICE_ROLES,
  STAFF_ROLES,
  USER_ROLES,
  USER_STATUSES,
} from '@ridemesh/types';
import { describe, expect, it } from 'vitest';
import { completeRegistrationInputSchema as functionsSchema } from '../functions/src/registration';
import { completeRegistrationInputSchema as sharedSchema } from '@ridemesh/types';

describe('functions and shared types stay aligned', () => {
  it('uses the same role lists', () => {
    expect([...functionsSelfService]).toEqual([...SELF_SERVICE_ROLES]);
    expect([...functionsStaff]).toEqual([...STAFF_ROLES]);
    expect([...SELF_SERVICE_ROLES, ...STAFF_ROLES].sort()).toEqual([...USER_ROLES].sort());
  });

  it('uses the same user statuses', () => {
    expect([...functionsStatuses]).toEqual([...USER_STATUSES]);
  });

  it('validates registration input identically', () => {
    const samples: unknown[] = [
      { role: 'PASSENGER', name: 'Ada' },
      { role: 'DRIVER', name: ' Ada ', phone: '+441234' },
      { role: 'ADMIN', name: 'Ada' },
      { role: 'DRIVER', name: '' },
      { role: 'DRIVER', name: 'Ada', phone: '' },
      {},
    ];
    for (const sample of samples) {
      expect(functionsSchema.safeParse(sample).success).toBe(
        sharedSchema.safeParse(sample).success,
      );
    }
  });

  it('starts a new driver profile with the same values', () => {
    expect(functionsDriverDefaults).toEqual(NEW_DRIVER_PROFILE_DEFAULTS);
  });

  it('starts a new driver profile in states the shared types allow', () => {
    expect(DRIVER_VERIFICATION_STATUSES).toContain(functionsDriverDefaults.verificationStatus);
    expect(DRIVER_AVAILABILITY_STATUSES).toContain(functionsDriverDefaults.availabilityStatus);
  });

  it('uses the same vehicle types, defaults and starting status', () => {
    expect([...functionsVehicleTypes]).toEqual([...VEHICLE_TYPES]);
    expect(functionsVehicleDefaults).toEqual(NEW_VEHICLE_DEFAULTS);
    expect(VEHICLE_VERIFICATION_STATUSES).toContain(functionsVehicleDefaults.verificationStatus);
  });

  it('validates vehicle input and plates identically', () => {
    const inputs: unknown[] = [
      { type: 'CAR', make: 'Toyota', model: 'Corolla', plateNumber: 'ABC-123' },
      { type: 'BUS', make: 'Toyota', model: 'Corolla', plateNumber: 'ABC-123' },
      { type: 'VAN', make: '  ', model: 'Transit', plateNumber: 'AB 12' },
      { type: 'MINIBUS', make: 'x'.repeat(51), model: 'Y', plateNumber: 'AB 12' },
      { type: 'CAR', make: 'A', model: 'B', plateNumber: 'x'.repeat(21) },
      { type: 'CAR', make: 'A', model: 'B' },
      {},
    ];
    for (const input of inputs) {
      expect(functionsVehicleSchema.safeParse(input).success).toBe(
        sharedVehicleSchema.safeParse(input).success,
      );
    }

    const plates = [
      'ABC-123',
      ' ab  12 cd ',
      'A',
      'AB#1',
      '- -',
      'ABCDEFGHIJKLM',
      'ab-12',
      '',
      'é12',
    ];
    for (const plate of plates) {
      expect(functionsNormalizePlate(plate)).toEqual(normalizePlate(plate));
      expect(functionsIsValidPlate(functionsNormalizePlate(plate))).toBe(
        isValidPlate(normalizePlate(plate)),
      );
    }
  });
});
