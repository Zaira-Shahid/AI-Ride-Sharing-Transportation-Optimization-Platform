'use client';

import type { ReactNode } from 'react';
import { useMobileSidebar } from './SidebarContext';

interface PageShellProps {
  title: string;
  children: ReactNode;
}

export function PageShell({ title, children }: PageShellProps) {
  const { open } = useMobileSidebar();

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-white/10 px-4 py-5 sm:px-8">
        <button
          type="button"
          onClick={open}
          aria-label="Open menu"
          className="rounded-md p-1 text-clean-white/70 hover:bg-white/5 hover:text-clean-white md:hidden"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 6h16M4 12h16M4 18h16"
            />
          </svg>
        </button>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      </header>
      <div className="flex-1 overflow-x-hidden p-4 sm:p-8">{children}</div>
    </div>
  );
}
