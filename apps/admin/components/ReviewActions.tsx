'use client';

import type { ReviewDecision } from '@ridemesh/types';
import { useState } from 'react';

interface ReviewActionsProps {
  status: 'PENDING' | 'VERIFIED' | 'REJECTED';
  reason: string | null;
  /** Only ADMIN/SUPER_ADMIN may actually submit a decision (REVIEWER_ROLES, @ridemesh/types) - anyone
   * else sees the status only, no buttons. */
  canReview: boolean;
  submitting: boolean;
  onReview: (decision: ReviewDecision, reason: string | null) => void;
}

const STATUS_STYLES: Record<ReviewActionsProps['status'], string> = {
  PENDING: 'bg-amber/15 text-amber',
  VERIFIED: 'bg-emerald/15 text-emerald',
  REJECTED: 'bg-danger-red/15 text-danger-red',
};

export function ReviewActions({
  status,
  reason,
  canReview,
  submitting,
  onReview,
}: ReviewActionsProps) {
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  return (
    <div className="space-y-2">
      <span
        className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}
      >
        {status}
      </span>
      {status === 'REJECTED' && reason ? (
        <p className="text-xs text-clean-white/50">{reason}</p>
      ) : null}

      {canReview ? (
        rejecting ? (
          <div className="flex flex-col gap-1">
            <input
              type="text"
              value={rejectReason}
              onChange={(event) => setRejectReason(event.target.value)}
              placeholder="Reason for rejection"
              disabled={submitting}
              className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs text-clean-white outline-none focus:border-electric-cyan"
            />
            <div className="flex gap-2">
              <button
                type="button"
                disabled={submitting || rejectReason.trim().length === 0}
                onClick={() => {
                  onReview('REJECTED', rejectReason.trim());
                  setRejecting(false);
                  setRejectReason('');
                }}
                className="rounded-md bg-danger-red/80 px-2 py-1 text-xs font-medium text-clean-white disabled:opacity-50"
              >
                Confirm reject
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={() => setRejecting(false)}
                className="rounded-md px-2 py-1 text-xs text-clean-white/60 hover:text-clean-white"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2">
            <button
              type="button"
              disabled={submitting || status === 'VERIFIED'}
              onClick={() => onReview('VERIFIED', null)}
              className="rounded-md bg-emerald/80 px-2 py-1 text-xs font-medium text-midnight-navy disabled:opacity-50"
            >
              Verify
            </button>
            <button
              type="button"
              disabled={submitting || status === 'REJECTED'}
              onClick={() => setRejecting(true)}
              className="rounded-md border border-danger-red/60 px-2 py-1 text-xs font-medium text-danger-red disabled:opacity-50"
            >
              Reject
            </button>
          </div>
        )
      ) : null}
    </div>
  );
}
