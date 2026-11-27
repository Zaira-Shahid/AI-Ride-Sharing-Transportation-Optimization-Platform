import { describe, expect, it } from 'vitest';
import { groupByTenant, isCompanyRide, sameTenant, tenantOf } from './tenant';

describe('tenantOf', () => {
  it('reads a company id', () => {
    expect(tenantOf({ companyId: 'acme' })).toBe('acme');
  });

  it.each([
    ['a missing field', {}],
    ['a null field', { companyId: null }],
    ['an empty string', { companyId: '' }],
    ['a number', { companyId: 7 }],
    ['an object', { companyId: { id: 'acme' } }],
    ['undefined', { companyId: undefined }],
  ])('treats %s as a consumer', (_name, data) => {
    expect(tenantOf(data)).toBeNull();
  });

  it('treats a missing document as a consumer', () => {
    expect(tenantOf(undefined)).toBeNull();
    expect(tenantOf(null)).toBeNull();
  });

  it('gives a missing field and an explicit null the same answer, which is the point', () => {
    expect(tenantOf({})).toBe(tenantOf({ companyId: null }));
  });
});

describe('sameTenant and isCompanyRide', () => {
  it('pairs consumers with consumers and a company only with itself', () => {
    expect(sameTenant(null, null)).toBe(true);
    expect(sameTenant('a', 'a')).toBe(true);
    expect(sameTenant('a', 'b')).toBe(false);
    expect(sameTenant('a', null)).toBe(false);
    expect(sameTenant(null, 'a')).toBe(false);
  });

  it('knows a company ride from a consumer one', () => {
    expect(isCompanyRide({ companyId: 'a' })).toBe(true);
    expect(isCompanyRide({})).toBe(false);
    expect(isCompanyRide({ companyId: null })).toBe(false);
  });
});

describe('groupByTenant', () => {
  const item = (id: string, tenant: string | null) => ({ id, tenant });

  it('puts consumers first, then companies in id order, keeping each group in its original order', () => {
    const groups = groupByTenant([
      item('1', 'zeta'),
      item('2', null),
      item('3', 'alpha'),
      item('4', null),
      item('5', 'zeta'),
      item('6', 'alpha'),
    ]);
    expect(groups.map(([tenant, items]) => [tenant, items.map((i) => i.id)])).toEqual([
      [null, ['2', '4']],
      ['alpha', ['3', '6']],
      ['zeta', ['1', '5']],
    ]);
  });

  it('with no company data is one group holding every item in its original order', () => {
    const items = [item('b', null), item('a', null), item('c', null)];
    const groups = groupByTenant(items);
    expect(groups).toHaveLength(1);
    expect(groups[0]![0]).toBeNull();
    expect(groups[0]![1]).toEqual(items);
  });

  it('is empty for no items', () => {
    expect(groupByTenant([])).toEqual([]);
  });
});
