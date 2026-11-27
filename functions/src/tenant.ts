// The company ("tenant") a trip request or a journey belongs to (module A3a,
// docs/a3-company-matching-design.md, section 2).
//
// A company ride carries `companyId: "<id>"`. A consumer's document carries NO such field and never
// will: it stays byte for byte what it was before companies existed. So code that needs to know a
// document's company does not ask Firestore (an equality on null would miss a document where the
// field is simply absent); it reads the document it already has and asks this helper. A non-empty
// string is a company. Anything else - absent, null, empty - is "a consumer", the same value.

/** A company's id, or null for a consumer. */
export type Tenant = string | null;

export function tenantOf(data: { companyId?: unknown } | null | undefined): Tenant {
  const value = data?.companyId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Two documents may only be paired when they belong to the same company, or both to no company. */
export function sameTenant(a: Tenant, b: Tenant): boolean {
  return a === b;
}

/**
 * Splits items by company, keeping each item's relative order. The consumer group (null) comes first,
 * then the companies in id order, so a run with no company data is exactly one group with every item
 * in its original order: the same input the code had before companies existed.
 */
export function groupByTenant<T extends { tenant: Tenant }>(items: readonly T[]): [Tenant, T[]][] {
  const groups = new Map<Tenant, T[]>();
  for (const item of items) {
    const group = groups.get(item.tenant);
    if (group) group.push(item);
    else groups.set(item.tenant, [item]);
  }
  return [...groups.entries()].sort(([a], [b]) => {
    if (a === b) return 0;
    if (a === null) return -1;
    if (b === null) return 1;
    return a.localeCompare(b);
  });
}

/** Whether a ride belongs to a company, as opposed to the consumer network. */
export function isCompanyRide(data: { companyId?: unknown } | null | undefined): boolean {
  return tenantOf(data) !== null;
}
