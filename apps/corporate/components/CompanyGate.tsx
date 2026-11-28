'use client';

import { COMPANY_CONSOLE_REFUSAL } from '@ridemesh/firebase/company';
import { useAuth } from '@ridemesh/firebase/react';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { redirectFor } from '../lib/routing';
import { secondaryButtonClass } from '../lib/ui';
import { AuthCard } from './AuthCard';
import { useCompanySession } from './CompanySession';
import { Sidebar } from './Sidebar';
import { MobileSidebarProvider } from './SidebarContext';

/**
 * Route protection for the whole console. Every page renders inside this gate (wired in the root
 * layout). Who may be where is decided by redirectFor (lib/routing.ts): signed-out visitors see only
 * the sign-in, sign-up and password reset pages, an unverified account only the verification page, an
 * account with no company only the create-company page, and the dashboard (sidebar and every page in
 * it) is drawn for a company administrator and nobody else. A passenger, a driver, platform staff or
 * an ordinary employee gets one plain refusal and a sign-out button.
 */
export function CompanyGate({ children }: { children: ReactNode }) {
  const { status } = useCompanySession();
  const { signOut } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const target = redirectFor(status, pathname);

  useEffect(() => {
    if (target) router.replace(target);
  }, [target, router]);

  if (status === 'loading' || target) {
    return (
      <div role="status" className="flex h-screen items-center justify-center text-clean-white/70">
        Loading…
      </div>
    );
  }

  if (status === 'refused') {
    return (
      <AuthCard title="Not available" subtitle={COMPANY_CONSOLE_REFUSAL}>
        <p className="text-sm text-clean-white/70">
          Sign in with the account you created for your company, or ask your company administrator
          for help.
        </p>
        <button type="button" onClick={() => void signOut()} className={secondaryButtonClass}>
          Sign out
        </button>
      </AuthCard>
    );
  }

  if (status !== 'admin') return <>{children}</>;

  return (
    <MobileSidebarProvider>
      <div className="flex h-screen overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </MobileSidebarProvider>
  );
}
