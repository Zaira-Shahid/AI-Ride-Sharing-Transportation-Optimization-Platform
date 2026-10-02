import { describe, expect, it } from 'vitest';
import { ADMIN_LIST_PAGE_SIZE, sliceStatusPage } from './paging';

// Phase 14 (performance): the admin lists read pageSize + 1 documents and keep pageSize, so that the
// extra one says whether there is a next page without opening an empty one.

const doc = (id: string, status?: string) => ({
  id,
  get: (field: string) => (field === 'status' ? status : undefined),
});

describe('sliceStatusPage', () => {
  it('is a page of 50', () => {
    expect(ADMIN_LIST_PAGE_SIZE).toBe(50);
  });

  it('gives the whole list and no next page when it fits', () => {
    const docs = [doc('a', 'ACTIVE'), doc('b', 'ACTIVE')];
    expect(sliceStatusPage(docs, 3, 'status')).toEqual({ docs, nextCursor: null });
  });

  it('gives no next page for a list that is exactly one page long', () => {
    const docs = [doc('a', 'ACTIVE'), doc('b', 'ACTIVE'), doc('c', 'ACTIVE')];
    const page = sliceStatusPage(docs, 3, 'status');
    expect(page.docs).toHaveLength(3);
    expect(page.nextCursor).toBeNull();
  });

  it('keeps pageSize documents and points the cursor at the last one it kept, not the extra', () => {
    const docs = [
      doc('a', 'PENDING'),
      doc('b', 'PENDING'),
      doc('c', 'VERIFIED'),
      doc('d', 'VERIFIED'),
    ];
    const page = sliceStatusPage(docs, 3, 'status');
    expect(page.docs.map((d) => d.id)).toEqual(['a', 'b', 'c']);
    expect(page.nextCursor).toEqual({ status: 'VERIFIED', id: 'c' });
  });

  it('reads the status from the field it is told', () => {
    const docs = [
      { id: 'a', get: (field: string) => (field === 'verificationStatus' ? 'REJECTED' : 'x') },
      { id: 'b', get: () => 'x' },
    ];
    expect(sliceStatusPage(docs, 1, 'verificationStatus').nextCursor).toEqual({
      status: 'REJECTED',
      id: 'a',
    });
  });

  it('copes with an empty list and a missing status', () => {
    expect(sliceStatusPage([], 3, 'status')).toEqual({ docs: [], nextCursor: null });
    expect(sliceStatusPage([doc('a'), doc('b')], 1, 'status').nextCursor).toEqual({
      status: '',
      id: 'a',
    });
  });
});
