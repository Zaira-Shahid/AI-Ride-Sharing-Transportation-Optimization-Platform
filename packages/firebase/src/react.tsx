import { onIdTokenChanged, signOut, type User } from 'firebase/auth';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { FirebaseClient } from './client';
import { deriveSessionStatus, type SessionStatus } from './session';

type Client = Pick<FirebaseClient, 'auth' | 'functions'>;

interface SessionSnapshot {
  status: SessionStatus;
  user: User | null;
  role: string | null;
}

interface AuthContextValue extends SessionSnapshot {
  client: Client;
  /** Reloads the user and their token, for example after they verified their email. */
  refresh: () => Promise<void>;
  /** Runs a multi-step sign-in or registration without the session flipping half-way through. */
  runAuthFlow: <T>(flow: () => Promise<T>) => Promise<T>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function readSession(client: Client): Promise<SessionSnapshot> {
  const user = client.auth.currentUser;
  if (!user) return { status: 'signedOut', user: null, role: null };
  const token = await user.getIdTokenResult();
  const role = typeof token.claims.role === 'string' ? token.claims.role : null;
  return {
    status: deriveSessionStatus({ signedIn: true, emailVerified: user.emailVerified, role }),
    user,
    role,
  };
}

export function AuthProvider({ client, children }: { client: Client; children: ReactNode }) {
  const [session, setSession] = useState<SessionSnapshot>({
    status: 'loading',
    user: null,
    role: null,
  });
  const activeFlows = useRef(0);
  const mounted = useRef(true);

  const update = useCallback(async () => {
    try {
      const next = await readSession(client);
      if (mounted.current && activeFlows.current === 0) setSession(next);
    } catch {
      if (mounted.current) setSession({ status: 'signedOut', user: null, role: null });
    }
  }, [client]);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = onIdTokenChanged(client.auth, () => {
      void update();
    });
    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [client, update]);

  const refresh = useCallback(async () => {
    const user = client.auth.currentUser;
    if (user) {
      await user.reload();
      await user.getIdToken(true);
    }
    await update();
  }, [client, update]);

  const runAuthFlow = useCallback(
    async <T,>(flow: () => Promise<T>) => {
      activeFlows.current += 1;
      try {
        return await flow();
      } finally {
        activeFlows.current -= 1;
        await update();
      }
    },
    [update],
  );

  const handleSignOut = useCallback(() => signOut(client.auth), [client]);

  const value = useMemo(
    () => ({ ...session, client, refresh, runAuthFlow, signOut: handleSignOut }),
    [session, client, refresh, runAuthFlow, handleSignOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider.');
  return context;
}
