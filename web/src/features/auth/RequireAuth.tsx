// Route guard. AuthProvider has already resolved /me by the time anything here
// renders, so there is no loading branch to handle - only "signed in or not".
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { useGuest } from '../guest/guestMode';

/** Where to send someone after they sign in. Encoded as a plain string rather than a
 *  location object so it survives a history entry being serialised. */
export function currentPath(location: { pathname: string; search: string; hash: string }): string {
  return `${location.pathname}${location.search}${location.hash}`;
}

export default function RequireAuth({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const guest = useGuest();
  const location = useLocation();

  // A guest has no session, and the shell is still theirs to use - it just runs on
  // browser-local data (see features/guest). The server is unaffected: every endpoint
  // below /api still requires a real session, and lib/api never calls one for a guest.
  if (!user && !guest) {
    // `replace` keeps the guarded URL out of history - Back from /login should leave
    // the app, not bounce through the page that just rejected them.
    return <Navigate to="/login" replace state={{ from: currentPath(location) }} />;
  }

  return <>{children}</>;
}
