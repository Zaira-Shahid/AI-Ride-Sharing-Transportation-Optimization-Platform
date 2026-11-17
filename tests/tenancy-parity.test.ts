import { COMPANY_MEMBER_PLATFORM_ROLES } from '@ridemesh/types';
import { COMPANY_ROLES as sharedCompanyRoles } from '@ridemesh/tenancy';
import { describe, expect, it } from 'vitest';
import {
  COMPANY_MEMBER_PLATFORM_ROLE as functionsPlatformRole,
  COMPANY_ROLES as functionsCompanyRoles,
} from '../functions/src/companyClaims';

describe('functions and the tenancy package stay aligned', () => {
  it('uses the same company roles', () => {
    expect([...functionsCompanyRoles]).toEqual([...sharedCompanyRoles]);
  });

  it('uses the same platform role for company members', () => {
    expect([functionsPlatformRole]).toEqual([...COMPANY_MEMBER_PLATFORM_ROLES]);
  });
});
