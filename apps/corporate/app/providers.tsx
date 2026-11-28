'use client';

import { AuthProvider } from '@ridemesh/firebase/react';
import type { ReactNode } from 'react';
import { CompanySessionProvider } from '../components/CompanySession';
import { getFirebaseClient } from '../lib/firebase';

// @ridemesh/firebase/react's own AuthProvider/useAuth carry no 'use client' directive themselves (they
// are shared with the React Native apps), so this file's own directive is what puts them in the client
// bundle here, the same way the admin console does it.
const client = getFirebaseClient();

export function Providers({ children }: { children: ReactNode }) {
  return (
    <AuthProvider client={client}>
      <CompanySessionProvider>{children}</CompanySessionProvider>
    </AuthProvider>
  );
}
