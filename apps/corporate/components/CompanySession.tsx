'use client';

import { useAuth } from '@ridemesh/firebase/react';
import { companyConsoleAccess } from '@ridemesh/firebase/company';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ConsoleStatus } from '../lib/routing';

// What the console knows about who is looking at it. It is read from the signed token, so it decides
// what to draw and nothing more: every company function checks the membership document on the server,
// so a token that is out of date can never do more than the server allows.

interface CompanySessionValue {
  status: ConsoleStatus;
}

const CompanySessionContext = createContext<CompanySessionValue | null>(null);

interface Resolved {
  uid: string;
  access: 'needs-company' | 'admin' | 'refused';
}

export function CompanySessionProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const { user } = auth;
  const signedInAndVerified = auth.status === 'ready' || auth.status === 'incomplete';

  // `auth` is a new object every time the session changes (a new token after creating a company, a
  // refresh after being demoted), so the claims are read again each time.
  useEffect(() => {
    if (!signedInAndVerified || !user) return undefined;
    let cancelled = false;
    user
      .getIdTokenResult()
      .then((token) => {
        if (!cancelled) {
          setResolved({ uid: user.uid, access: companyConsoleAccess(token.claims) });
        }
      })
      .catch(() => {
        if (!cancelled) setResolved({ uid: user.uid, access: 'refused' });
      });
    return () => {
      cancelled = true;
    };
  }, [auth, signedInAndVerified, user]);

  const status = useMemo((): ConsoleStatus => {
    if (auth.status === 'loading') return 'loading';
    if (auth.status === 'signedOut') return 'signedOut';
    if (auth.status === 'unverified') return 'unverified';
    if (!user || resolved?.uid !== user.uid) return 'loading';
    if (resolved.access === 'admin') return 'admin';
    return resolved.access === 'needs-company' ? 'needsCompany' : 'refused';
  }, [auth.status, user, resolved]);

  const value = useMemo(() => ({ status }), [status]);
  return <CompanySessionContext.Provider value={value}>{children}</CompanySessionContext.Provider>;
}

export function useCompanySession(): CompanySessionValue {
  const context = useContext(CompanySessionContext);
  if (!context) throw new Error('useCompanySession must be used inside a CompanySessionProvider.');
  return context;
}
