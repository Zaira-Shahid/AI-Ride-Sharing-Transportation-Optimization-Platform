import {
  SELF_SERVICE_ROLES as functionsSelfService,
  STAFF_ROLES as functionsStaff,
  USER_STATUSES as functionsStatuses,
} from '../functions/src/roles';
import { SELF_SERVICE_ROLES, STAFF_ROLES, USER_ROLES, USER_STATUSES } from '@ridemesh/types';
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
});
