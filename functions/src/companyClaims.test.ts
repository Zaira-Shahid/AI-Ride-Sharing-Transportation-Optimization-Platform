import { describe, expect, it } from 'vitest';
import {
  CompanyClaimsError,
  clearCompanyClaims,
  setCompanyClaims,
  type ClaimsAuth,
} from './companyClaims';

function fakeAuth(initial: Record<string, Record<string, unknown> | undefined>) {
  const store = new Map(Object.entries(initial));
  const revoked: string[] = [];
  const auth = {
    getUser: (uid: string) => Promise.resolve({ uid, customClaims: store.get(uid) }),
    setCustomUserClaims: (uid: string, claims: Record<string, unknown> | null) => {
      store.set(uid, claims ?? undefined);
      return Promise.resolve();
    },
    revokeRefreshTokens: (uid: string) => {
      revoked.push(uid);
      return Promise.resolve();
    },
  } as unknown as ClaimsAuth;
  return { auth, store, revoked };
}

describe('setCompanyClaims', () => {
  it('makes a fresh account an employee of the company', async () => {
    const { auth, store } = fakeAuth({ u1: undefined });
    await setCompanyClaims(auth, 'u1', { companyId: 'c1', companyRole: 'EMPLOYEE' });
    expect(store.get('u1')).toEqual({ role: 'EMPLOYEE', companyId: 'c1', companyRole: 'EMPLOYEE' });
  });

  it('keeps unrelated claims', async () => {
    const { auth, store } = fakeAuth({ u1: { beta: true } });
    await setCompanyClaims(auth, 'u1', { companyId: 'c1', companyRole: 'COMPANY_ADMIN' });
    expect(store.get('u1')).toEqual({
      beta: true,
      role: 'EMPLOYEE',
      companyId: 'c1',
      companyRole: 'COMPANY_ADMIN',
    });
  });

  it('can change the company role within the same company, and a retry is harmless', async () => {
    const { auth, store } = fakeAuth({
      u1: { role: 'EMPLOYEE', companyId: 'c1', companyRole: 'EMPLOYEE' },
    });
    await setCompanyClaims(auth, 'u1', { companyId: 'c1', companyRole: 'COMPANY_ADMIN' });
    await setCompanyClaims(auth, 'u1', { companyId: 'c1', companyRole: 'COMPANY_ADMIN' });
    expect(store.get('u1')).toEqual({
      role: 'EMPLOYEE',
      companyId: 'c1',
      companyRole: 'COMPANY_ADMIN',
    });
  });

  it.each(['PASSENGER', 'DRIVER', 'ADMIN', 'SUPER_ADMIN'])(
    'refuses an account that already has the %s role',
    async (role) => {
      const { auth, store } = fakeAuth({ u1: { role } });
      await expect(
        setCompanyClaims(auth, 'u1', { companyId: 'c1', companyRole: 'EMPLOYEE' }),
      ).rejects.toBeInstanceOf(CompanyClaimsError);
      expect(store.get('u1')).toEqual({ role });
    },
  );

  it('refuses an account that already belongs to another company', async () => {
    const { auth, store } = fakeAuth({
      u1: { role: 'EMPLOYEE', companyId: 'c1', companyRole: 'EMPLOYEE' },
    });
    await expect(
      setCompanyClaims(auth, 'u1', { companyId: 'c2', companyRole: 'EMPLOYEE' }),
    ).rejects.toThrow('another company');
    expect(store.get('u1')?.companyId).toBe('c1');
  });

  it('refuses an empty company and an unknown company role', async () => {
    const { auth } = fakeAuth({ u1: undefined });
    await expect(
      setCompanyClaims(auth, 'u1', { companyId: '', companyRole: 'EMPLOYEE' }),
    ).rejects.toBeInstanceOf(CompanyClaimsError);
    await expect(
      setCompanyClaims(auth, 'u1', {
        companyId: 'c1',
        companyRole: 'OWNER' as unknown as 'EMPLOYEE',
      }),
    ).rejects.toBeInstanceOf(CompanyClaimsError);
  });
});

describe('clearCompanyClaims', () => {
  it('removes the company claims and the EMPLOYEE role, keeps the rest, and revokes tokens', async () => {
    const { auth, store, revoked } = fakeAuth({
      u1: { beta: true, role: 'EMPLOYEE', companyId: 'c1', companyRole: 'EMPLOYEE' },
    });
    expect(await clearCompanyClaims(auth, 'u1')).toBe(true);
    expect(store.get('u1')).toEqual({ beta: true });
    expect(revoked).toEqual(['u1']);
  });

  it('does nothing for an account with no company claims, and never touches another role', async () => {
    const { auth, store, revoked } = fakeAuth({ u1: { role: 'PASSENGER' }, u2: undefined });
    expect(await clearCompanyClaims(auth, 'u1')).toBe(false);
    expect(await clearCompanyClaims(auth, 'u2')).toBe(false);
    expect(store.get('u1')).toEqual({ role: 'PASSENGER' });
    expect(revoked).toEqual([]);
  });
});
