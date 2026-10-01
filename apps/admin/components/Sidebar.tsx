'use client';

import { APP_DISPLAY_NAMES } from '@ridemesh/config';
import { useAuth } from '@ridemesh/firebase/react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NAV_ITEMS } from '../lib/navigation';
import { useMobileSidebar } from './SidebarContext';

/**
 * Phase 14 (production hardening): below md (768px) this is an off-canvas drawer, closed by
 * default - fixed, translated fully off-screen, slid in over a dimming backdrop when
 * useMobileSidebar's own isOpen is true (opened by PageShell's menu button, closed by the backdrop,
 * the X button here, or choosing a page). At md and up it reverts to exactly its old always-visible,
 * in-flow behavior (the mobile-only classes stop applying), so desktop is unchanged.
 */
export function Sidebar() {
  const pathname = usePathname();
  const { user, signOut } = useAuth();
  const { isOpen, close } = useMobileSidebar();

  return (
    <>
      {isOpen ? (
        <div
          aria-hidden="true"
          onClick={close}
          className="fixed inset-0 z-20 bg-midnight-navy/60 md:hidden"
        />
      ) : null}
      <aside
        className={`fixed inset-y-0 left-0 z-30 flex w-64 shrink-0 -translate-x-full flex-col border-r border-white/10 bg-deep-slate transition-transform duration-200 md:static md:translate-x-0 ${
          isOpen ? 'translate-x-0' : ''
        }`}
      >
        <div className="flex items-center justify-between px-6 py-5">
          <span className="text-lg font-semibold tracking-tight">{APP_DISPLAY_NAMES.admin}</span>
          <button
            type="button"
            onClick={close}
            aria-label="Close menu"
            className="rounded-md p-1 text-clean-white/70 hover:bg-white/5 hover:text-clean-white md:hidden"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
        <nav aria-label="Primary" className="flex-1 overflow-y-auto px-3 pb-6">
          <ul className="space-y-1">
            {NAV_ITEMS.map((item) => {
              const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
              return (
                <li key={item.slug}>
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    onClick={close}
                    className={`block rounded-md px-3 py-2 text-sm transition-colors ${
                      active
                        ? 'bg-electric-cyan/15 text-electric-cyan'
                        : 'text-clean-white/70 hover:bg-white/5 hover:text-clean-white'
                    }`}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="border-t border-white/10 px-3 py-4">
          {user?.email ? (
            <p className="truncate px-3 pb-2 text-xs text-clean-white/50">{user.email}</p>
          ) : null}
          <button
            type="button"
            onClick={() => void signOut()}
            className="block w-full rounded-md px-3 py-2 text-left text-sm text-clean-white/70 transition-colors hover:bg-white/5 hover:text-clean-white"
          >
            Sign out
          </button>
        </div>
      </aside>
    </>
  );
}
