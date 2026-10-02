'use client';

/** The "Load more" under a paged admin list; nothing when the list has no further page. */
export function LoadMoreButton({
  visible,
  loading,
  onClick,
}: {
  visible: boolean;
  loading: boolean;
  onClick: () => void;
}) {
  if (!visible) return null;
  return (
    <button
      type="button"
      disabled={loading}
      onClick={onClick}
      className="rounded-md border border-white/10 px-3 py-1.5 text-sm text-clean-white/70 hover:text-clean-white disabled:opacity-50"
    >
      {loading ? 'Loading…' : 'Load more'}
    </button>
  );
}
