'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';

// Below the md breakpoint the sidebar is an off-canvas drawer, closed by default (copied and adapted
// from the admin console, which is deliberately left untouched). This is the open/closed state shared
// between the drawer itself (Sidebar.tsx) and the menu button that opens it (PageShell.tsx).
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
