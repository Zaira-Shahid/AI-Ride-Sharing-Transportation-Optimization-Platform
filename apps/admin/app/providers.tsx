'use client';

import { AuthProvider } from '@ridemesh/firebase/react';
import type { ReactNode } from 'react';
import { getFirebaseClient } from '../lib/firebase';

// @ridemesh/firebase/react's own AuthProvider/useAuth carry no 'use client' directive themselves
// (they are shared with the React Native apps, which have no such concept) - this file's own
// directive is what puts them in the client bundle here, the same "the consuming app draws the
// boundary" approach every other Next.js consumer of a shared React library takes.
const client = getFirebaseClient();

export function Providers({ children }: { children: ReactNode }) {
  return <AuthProvider client={client}>{children}</AuthProvider>;
}
