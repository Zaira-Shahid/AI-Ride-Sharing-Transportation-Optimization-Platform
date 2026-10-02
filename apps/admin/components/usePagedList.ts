'use client';

import { useCallback, useEffect, useState } from 'react';
import { describeAuthError } from '@ridemesh/firebase';

/** One page as the list functions in @ridemesh/firebase return it. */
interface PageResult<Row, Cursor> {
  rows: Row[];
  nextCursor: Cursor | null;
}

/**
 * Phase 14 (performance): the paging the Drivers, Vehicles and Passengers pages share. It loads the
 * first page when the page opens, appends the next one on `loadMore`, and starts again from the first
 * page on `reload` (after a decision, since rows change status and so move). `loadPage` must keep the
 * same identity between renders (wrap it in useCallback), or the list reloads on every render.
 */
export function usePagedList<Row, Cursor>(
  loadPage: (cursor: Cursor | null) => Promise<PageResult<Row, Cursor>>,
) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const page = await loadPage(null);
      setRows(page.rows);
      setCursor(page.nextCursor);
      setHasMore(page.nextCursor !== null);
    } catch (caught) {
      setError(describeAuthError(caught).message);
    }
  }, [loadPage]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const loadMore = useCallback(async () => {
    if (cursor === null) return;
    setLoadingMore(true);
    try {
      const page = await loadPage(cursor);
      setRows((current) => [...(current ?? []), ...page.rows]);
      setCursor(page.nextCursor);
      setHasMore(page.nextCursor !== null);
    } catch (caught) {
      setError(describeAuthError(caught).message);
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadPage]);

  return { rows, error, setError, hasMore, loadingMore, loadMore, reload };
}
