import { COMPANY_MEMBER_PLATFORM_ROLES } from '@ridemesh/types';
import * as shared from '@ridemesh/tenancy';
import { describe, expect, it } from 'vitest';
import * as fromFunctions from '../functions/src/companies';
import {
  COMPANY_MEMBER_PLATFORM_ROLE as functionsPlatformRole,
  COMPANY_ROLES as functionsCompanyRoles,
} from '../functions/src/companyClaims';

describe('functions and the tenancy package stay aligned', () => {
  it('uses the same company roles', () => {
    expect([...functionsCompanyRoles]).toEqual([...shared.COMPANY_ROLES]);
  });

  it('uses the same platform role for company members', () => {
    expect([functionsPlatformRole]).toEqual([...COMPANY_MEMBER_PLATFORM_ROLES]);
  });
});

type Parser = { safeParse: (value: unknown) => { success: boolean; data?: unknown } };

describe('company onboarding: functions and the tenancy package stay aligned', () => {
  it('uses the same limits', () => {
    expect(fromFunctions.COMPANY_NAME_MAX).toBe(shared.COMPANY_NAME_MAX);
    expect(fromFunctions.PERSON_NAME_MAX).toBe(shared.PERSON_NAME_MAX);
    expect(fromFunctions.PHONE_MAX).toBe(shared.PHONE_MAX);
    expect(fromFunctions.EMAIL_MAX).toBe(shared.EMAIL_MAX);
    expect(fromFunctions.COMPANY_CREATIONS_PER_ACCOUNT_PER_DAY).toBe(
      shared.COMPANY_CREATIONS_PER_ACCOUNT_PER_DAY,
    );
    expect(fromFunctions.INVITES_PER_ADMIN_PER_HOUR).toBe(shared.INVITES_PER_ADMIN_PER_HOUR);
    expect(fromFunctions.MAX_PENDING_INVITATIONS).toBe(shared.MAX_PENDING_INVITATIONS);
    expect(fromFunctions.EMPLOYEES_PAGE_SIZE).toBe(shared.EMPLOYEES_PAGE_SIZE);
    expect(fromFunctions.INVITATIONS_LIST_LIMIT).toBe(shared.INVITATIONS_LIST_LIMIT);
    expect(fromFunctions.INVITATION_TTL_DAYS).toBe(shared.INVITATION_TTL_DAYS);
  });

  // Each pair must accept and reject exactly the same inputs, and give the same result when it accepts.
  const pairs: [string, Parser, Parser, unknown[]][] = [
    [
      'createCompany',
      fromFunctions.createCompanyInputSchema,
      shared.createCompanyInputSchema,
      [
        { name: 'Acme', ownerName: 'Ana' },
        { name: '  Acme Ltd  ', ownerName: ' Ana ', phone: ' +441234567 ' },
        { name: 'A', ownerName: 'Ana' },
        { name: 'x'.repeat(101), ownerName: 'Ana' },
        { name: 'Acme', ownerName: '' },
        { name: 'Acme', ownerName: 'y'.repeat(101) },
        { name: 'Acme', ownerName: 'Ana', phone: '' },
        { name: 'Acme', ownerName: 'Ana', phone: null },
        { name: 'Acme', ownerName: 'Ana', phone: '1'.repeat(33) },
        { name: 'Acme' },
        {},
        null,
      ],
    ],
    [
      'inviteEmployee',
      fromFunctions.inviteEmployeeInputSchema,
      shared.inviteEmployeeInputSchema,
      [
        { email: 'new@example.test' },
        { email: '  NEW@Example.TEST ', companyRole: 'COMPANY_ADMIN' },
        { email: 'not-an-email' },
        { email: '' },
        { email: `${'a'.repeat(250)}@x.co` },
        { email: 'a@b.co', companyRole: 'OWNER' },
        { email: 'a@b.co', companyRole: null },
        { companyRole: 'EMPLOYEE' },
        null,
      ],
    ],
    [
      'acceptInvitation',
      fromFunctions.acceptInvitationInputSchema,
      shared.acceptInvitationInputSchema,
      [
        { code: 'abc.def', name: 'Ben' },
        { code: ' abc.def ', name: ' Ben ', phone: '+4412345' },
        { code: '', name: 'Ben' },
        { code: 'x'.repeat(201), name: 'Ben' },
        { code: 'abc.def', name: '' },
        { code: 'abc.def', name: 'Ben', phone: '' },
        { code: 'abc.def', name: 'Ben', phone: null },
        { name: 'Ben' },
      ],
    ],
    [
      'revokeInvitation',
      fromFunctions.revokeInvitationInputSchema,
      shared.revokeInvitationInputSchema,
      [
        { invitationId: 'abc' },
        { invitationId: ' abc ' },
        { invitationId: '' },
        { invitationId: 'x'.repeat(129) },
        {},
      ],
    ],
    [
      'listEmployees',
      fromFunctions.listEmployeesInputSchema,
      shared.listEmployeesInputSchema,
      [{}, { cursor: null }, { cursor: 'uid1' }, { cursor: '' }, { cursor: 'x'.repeat(129) }],
    ],
    [
      'removeEmployee',
      fromFunctions.removeEmployeeInputSchema,
      shared.removeEmployeeInputSchema,
      [{ uid: 'u1' }, { uid: '' }, { uid: 'x'.repeat(129) }, {}],
    ],
    [
      'setEmployeeRole',
      fromFunctions.setEmployeeRoleInputSchema,
      shared.setEmployeeRoleInputSchema,
      [
        { uid: 'u1', companyRole: 'EMPLOYEE' },
        { uid: 'u1', companyRole: 'COMPANY_ADMIN' },
        { uid: 'u1', companyRole: 'OWNER' },
        { uid: 'u1' },
        { companyRole: 'EMPLOYEE' },
      ],
    ],
  ];

  it.each(pairs)('%s validates the same inputs the same way', (_name, mine, theirs, inputs) => {
    for (const input of inputs) {
      const a = mine.safeParse(input);
      const b = theirs.safeParse(input);
      expect(a.success, JSON.stringify(input)).toBe(b.success);
      if (a.success) expect(a.data).toEqual(b.data);
    }
  });
});
