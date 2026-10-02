// Phase 14 (Performance, spec section 71 "avoid unbounded queries ... use pagination"): the shape of a
// page of an admin list. The Drivers, Vehicles and Passengers pages used to read EVERY document of
// their collection in the staff member's browser; they now read one page and ask for the next on
// demand, the same "Load more" the trip history already had.

/** How many rows an admin list loads at a time. */
export const ADMIN_LIST_PAGE_SIZE = 50;

export interface PageOptions<Cursor> {
  /** Where the page after this one starts; leave out for the first page. */
  cursor?: Cursor | null | undefined;
  /** Rows per page. Only a test needs to change it. */
  pageSize?: number | undefined;
}

export interface Page<Row, Cursor> {
  rows: Row[];
  /** What to pass as `cursor` for the next page; null when this was the last. */
  nextCursor: Cursor | null;
}

/**
 * Where the next page of a list ordered by a status field and then by document id starts: after the
 * document with this status value and this id. Both are needed, because many documents share a status.
 */
export interface StatusCursor {
  status: string;
  id: string;
}

/**
 * Splits what a query for `pageSize + 1` documents returned into the page and the cursor for the next
 * one. Asking for one more than a page is how it is known there IS a next page, so a list that is
 * exactly a page long does not offer a "Load more" that opens an empty page.
 */
export function sliceStatusPage<D extends { id: string; get(field: string): unknown }>(
  docs: readonly D[],
  pageSize: number,
  statusField: string,
): { docs: D[]; nextCursor: StatusCursor | null } {
  const page = docs.slice(0, pageSize);
  const last = page.at(-1);
  const hasMore = docs.length > pageSize;
  return {
    docs: page,
    nextCursor:
      hasMore && last ? { status: String(last.get(statusField) ?? ''), id: last.id } : null,
  };
}
