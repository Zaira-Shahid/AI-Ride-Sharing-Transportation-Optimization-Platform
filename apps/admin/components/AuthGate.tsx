'use client';

import { useAuth } from '@ridemesh/firebase/react';
import { isStaffRole } from '@ridemesh/types';
import { useEffect, type ReactNode } from 'react';
import { LoginForm } from './LoginForm';
import { Sidebar } from './Sidebar';

/**
 * Module 11.1 (admin dashboard foundation): route protection for the whole console. Every page in
 * apps/admin renders inside this gate (wired in the root layout) - nobody signed out, unverified, or
 * signed in with a non-staff role (PASSENGER/DRIVER, or no role at all) ever sees the sidebar or any
 * page's own content, only the sign-in form.
 *
 * signInStaff itself already refuses and signs out a non-staff account at sign-in time (see its own
 * doc comment) - the effect below is a defensive backstop for the rarer case of an already-open
 * session whose role was later revoked (module 11's own staff-role script always revokes refresh
 * tokens when it does, but an existing tab's own cached ID token is only ever re-checked here, on the
 * next onIdTokenChanged tick).
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { status, role, signOut } = useAuth();
  const authorized = status === 'ready' && isStaffRole(role);

  useEffect(() => {
    if (status === 'ready' && !isStaffRole(role)) {
      void signOut();
    }
  }, [status, role, signOut]);

  if (status === 'loading') {
    return (
      <div className="flex h-screen items-center justify-center text-clean-white/60">Loading…</div>
    );
  }

  if (!authorized) {
    return <LoginForm />;
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
