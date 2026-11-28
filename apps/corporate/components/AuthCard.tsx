import type { ReactNode } from 'react';

/** The centred card every signed-out and onboarding screen sits in. */
export function AuthCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm space-y-4 rounded-xl border border-white/10 bg-deep-slate p-8">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-clean-white">{title}</h1>
          {subtitle ? <p className="mt-1 text-sm text-clean-white/70">{subtitle}</p> : null}
        </div>
        {children}
      </div>
    </div>
  );
}

export function ErrorNotice({ message }: { message: string }) {
  return (
    <p role="alert" className="rounded-md bg-danger-red/10 px-3 py-2 text-sm text-danger-text">
      {message}
    </p>
  );
}

export function InfoNotice({ message }: { message: string }) {
  return (
    <p role="status" className="rounded-md bg-emerald/10 px-3 py-2 text-sm text-emerald">
      {message}
    </p>
  );
}
