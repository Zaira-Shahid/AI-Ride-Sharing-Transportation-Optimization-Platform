'use client';

import { APP_DISPLAY_NAMES } from '@ridemesh/config';
import { useAuth } from '@ridemesh/firebase/react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NAV_ITEMS } from '../lib/navigation';

export function Sidebar() {
  const pathname = usePathname();
  const { user, signOut } = useAuth();

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-white/10 bg-deep-slate">
      <div className="px-6 py-5 text-lg font-semibold tracking-tight">
        {APP_DISPLAY_NAMES.admin}
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
  );
}
