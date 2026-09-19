import type { ReactNode } from 'react';

interface PageShellProps {
  title: string;
  children: ReactNode;
}

export function PageShell({ title, children }: PageShellProps) {
  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-white/10 px-8 py-5">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      </header>
      <div className="flex-1 p-8">{children}</div>
    </div>
  );
}
