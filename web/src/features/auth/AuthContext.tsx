// Session state for the whole app. Mounted above the router's routes so every page,
// public or guarded, reads the same user.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, setUnauthorizedHandler } from '../../lib/api';
import type { User } from '../../lib/types';
import './auth.css';

export interface AuthState {
  user: User | null;
  /** True only until the first /me settles. Guards and pages must wait on it. */
  loading: boolean;
  signup: (b: {
    email: string;
    password: string;
    displayName?: string;
  }) => Promise<{ user: User; recoveryKey: string }>;
  login: (b: { email: string; password: string }) => Promise<User>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthCtx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const { user: me } = await api.me();
      setUser(me);
    } catch (e) {
      // A 401 here is the normal "not signed in" answer, not a failure. Anything else
      // (server down, network) also leaves us signed out — the guard will route to
      // /login, where the real error becomes visible on the next attempt.
      if (!(e instanceof ApiError) || e.status !== 401) {
        console.warn('Could not establish session', e);
      }
      setUser(null);
    }
  }, []);

  // Establish the session once, on mount. Nothing below renders until this settles,
  // which is what stops an already-signed-in user seeing a flash of the login page.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await refresh();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  // A 401 from any non-auth endpoint means the cookie died mid-session. Dropping the
  // user here is enough: RequireAuth re-renders into a redirect, preserving the URL.
  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    return () => setUnauthorizedHandler(null);
  }, []);

  // Returns the recovery key alongside the user: this is the only moment it exists
  // in transmittable form, so the caller is responsible for showing it before it is
  // dropped. See RecoveryKeyPanel.
  const signup = useCallback(async (b: { email: string; password: string; displayName?: string }) => {
    const { user: created, recoveryKey } = await api.signup(b);
    setUser(created);
    return { user: created, recoveryKey };
  }, []);

  const login = useCallback(async (b: { email: string; password: string }) => {
    const { user: signedIn } = await api.login(b);
    setUser(signedIn);
    return signedIn;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      // Clear locally even if the request failed — the user asked to be signed out, and
      // a stale-looking signed-in UI is worse than a cookie the server prunes later.
      setUser(null);
    }
  }, []);

  if (loading) return <AuthSplash />;

  return <AuthCtx.Provider value={{ user, loading, signup, login, logout, refresh }}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}

/** Blank-then-spinner: the CSS fades this in after a beat, so a fast /me (the common
 *  case) shows nothing at all rather than a one-frame flicker. */
function AuthSplash() {
  return (
    <div className="auth-splash" role="status" aria-label="Loading Unote">
      <span className="auth-splash__mark" aria-hidden="true">
        📓
      </span>
    </div>
  );
}
