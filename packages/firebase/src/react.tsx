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
import { subscribeToDriverProfile, type DriverProfileSnapshot } from './driver';
import { subscribeToJourney, type JourneySnapshot } from './journey';
import { subscribeToJourneyPlanStops, type JourneyPlanStopsSnapshot } from './journeyPlan';
import { subscribeToProfile, type ProfileSnapshot } from './profile';
import { deriveSessionStatus, type SessionStatus } from './session';
import {
  subscribeToCurrentTripRequest,
  subscribeToMyTripRequests,
  type TripListSnapshot,
  type TripRequestSnapshot,
} from './trip';
import { subscribeToVehicle, type VehicleSnapshot } from './vehicle';

type Client = Pick<FirebaseClient, 'auth' | 'functions' | 'firestore'>;

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

type LiveState<Snapshot> = { status: 'loading' } | Snapshot | { status: 'error' };

/** Follows one document of the signed-in person, keeping it up to date, with a retry. */
type Subscribe<Snapshot> = (
  client: Client,
  id: string,
  onChange: (snapshot: Snapshot) => void,
  onError: (error: unknown) => void,
) => () => void;

function useLiveSubscription<Snapshot>(
  subscribe: Subscribe<Snapshot>,
  id: string | undefined,
): LiveState<Snapshot> & { retry: () => void } {
  const { client } = useAuth();
  const [state, setState] = useState<LiveState<Snapshot>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setState({ status: 'loading' });
    if (!id) return undefined;
    return subscribe(
      client,
      id,
      (snapshot) => setState(snapshot),
      () => setState({ status: 'error' }),
    );
  }, [client, id, attempt, subscribe]);

  const retry = useCallback(() => setAttempt((count) => count + 1), []);
  return { ...state, retry };
}

/** Follows a document keyed by the signed-in person's uid. */
function useLiveDocument<Snapshot>(subscribe: Subscribe<Snapshot>) {
  const { user } = useAuth();
  return useLiveSubscription(subscribe, user?.uid);
}

export type ProfileState = LiveState<ProfileSnapshot>;

/** The signed-in person's users/{uid} document, kept up to date. */
export function useProfile() {
  return useLiveDocument(subscribeToProfile);
}

export type DriverProfileState = LiveState<DriverProfileSnapshot>;

/** The signed-in driver's drivers/{uid} document, kept up to date. Use it in driver screens only. */
export function useDriverProfile() {
  return useLiveDocument(subscribeToDriverProfile);
}

export type VehicleState = LiveState<VehicleSnapshot>;

/** The signed-in driver's vehicles/{uid} document, kept up to date. Use it in driver screens only. */
export function useVehicle() {
  return useLiveDocument(subscribeToVehicle);
}

export type JourneyState = LiveState<JourneySnapshot>;

/** The driver's journey (driverJourneys/{id}), kept up to date. Missing when there is none. */
export function useJourney(journeyId: string | null): JourneyState & { retry: () => void } {
  const live = useLiveSubscription(subscribeToJourney, journeyId ?? undefined);
  return journeyId ? live : { status: 'missing', retry: live.retry };
}

export type JourneyPlanStopsState = LiveState<JourneyPlanStopsSnapshot>;

/**
 * The stops of journey `journeyId`'s current plan (Module 7.1), kept up to date. 'none' while it has
 * no matched passengers yet. Use it in driver screens only.
 */
export function useJourneyPlanStops(
  journeyId: string | null,
): JourneyPlanStopsState & { retry: () => void } {
  const live = useLiveSubscription(subscribeToJourneyPlanStops, journeyId ?? undefined);
  return journeyId ? live : { status: 'none', retry: live.retry };
}

export type TripRequestState = LiveState<TripRequestSnapshot>;

/** The signed-in passenger's open trip request, kept up to date. 'none' when they have no open one. */
export function useCurrentTripRequest() {
  return useLiveDocument(subscribeToCurrentTripRequest);
}

export type TripListState = LiveState<TripListSnapshot>;

/** The signed-in passenger's own trip requests, newest first, kept up to date. */
export function useMyTripRequests() {
  return useLiveDocument(subscribeToMyTripRequests);
}
