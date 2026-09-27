'use client';

import type { UserStatus } from '@ridemesh/types';
import { useState } from 'react';

interface UserStatusActionsProps {
  status: UserStatus;
  reason: string | null;
  /** Only ADMIN/SUPER_ADMIN may actually change an account's status (REVIEWER_ROLES) - anyone else
   * sees the status only, no buttons. */
  canManage: boolean;
  submitting: boolean;
  onChange: (status: UserStatus, reason: string | null) => void;
}

const STATUS_STYLES: Record<UserStatus, string> = {
  ACTIVE: 'bg-emerald/15 text-emerald',
  SUSPENDED: 'bg-danger-red/15 text-danger-red',
};

export function UserStatusActions({
  status,
  reason,
  canManage,
  submitting,
  onChange,
}: UserStatusActionsProps) {
  const [suspending, setSuspending] = useState(false);
  const [suspendReason, setSuspendReason] = useState('');

  return (
    <div className="space-y-2">
      <span
        className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}
      >
        {status}
      </span>
      {status === 'SUSPENDED' && reason ? (
        <p className="text-xs text-clean-white/50">{reason}</p>
      ) : null}

      {canManage ? (
        suspending ? (
          <div className="flex flex-col gap-1">
            <input
              type="text"
              value={suspendReason}
              onChange={(event) => setSuspendReason(event.target.value)}
              placeholder="Reason for suspension"
              disabled={submitting}
              className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs text-clean-white outline-none focus:border-electric-cyan"
            />
            <div className="flex gap-2">
              <button
                type="button"
                disabled={submitting || suspendReason.trim().length === 0}
                onClick={() => {
                  onChange('SUSPENDED', suspendReason.trim());
                  setSuspending(false);
                  setSuspendReason('');
                }}
                className="rounded-md bg-danger-red/80 px-2 py-1 text-xs font-medium text-clean-white disabled:opacity-50"
              >
                Confirm suspend
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={() => setSuspending(false)}
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
              disabled={submitting || status === 'ACTIVE'}
              onClick={() => onChange('ACTIVE', null)}
              className="rounded-md bg-emerald/80 px-2 py-1 text-xs font-medium text-midnight-navy disabled:opacity-50"
            >
              Reinstate
            </button>
            <button
              type="button"
              disabled={submitting || status === 'SUSPENDED'}
              onClick={() => setSuspending(true)}
              className="rounded-md border border-danger-red/60 px-2 py-1 text-xs font-medium text-danger-red disabled:opacity-50"
            >
              Suspend
            </button>
          </div>
        )
      ) : null}
    </div>
  );
}
