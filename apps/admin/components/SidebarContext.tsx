'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';

/**
 * Phase 14 (production hardening): the admin shell's own fixed 256px sidebar (Sidebar.tsx) was
 * unusable at phone width - it alone took up most of a 390px viewport, leaving barely anything for
 * the actual page. Below the md breakpoint it now becomes an off-canvas drawer instead, closed by
 * default; this context is the shared open/closed state between the drawer itself (Sidebar.tsx) and
 * the menu button that opens it (PageShell.tsx, rendered separately by every page) - the two are
 * siblings under AuthGate, not parent/child, so a plain prop cannot pass between them.
 */
interface MobileSidebarContextValue {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

const MobileSidebarContext = createContext<MobileSidebarContextValue | null>(null);

export function MobileSidebarProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <MobileSidebarContext.Provider
      value={{ isOpen, open: () => setIsOpen(true), close: () => setIsOpen(false) }}
    >
      {children}
    </MobileSidebarContext.Provider>
  );
}

export function useMobileSidebar(): MobileSidebarContextValue {
  const context = useContext(MobileSidebarContext);
  if (!context) {
    throw new Error('useMobileSidebar must be used inside a MobileSidebarProvider.');
  }
  return context;
}
