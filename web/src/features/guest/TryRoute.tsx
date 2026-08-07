// /try - the door into the app for someone who has not made an account.
//
// It is a route rather than a button handler so the choice is linkable and survives a
// reload, and so the marketing page, the login page and the signup page can all point at
// the same one place that knows how guest mode starts.
import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { guestModeSupported, isGuest, startGuest } from './guestMode';

export default function TryRoute() {
  const { user } = useAuth();
  const [target, setTarget] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    if (user) return; // already signed in - the redirect below wins
    if (!guestModeSupported()) {
      setBlocked(true);
      return;
    }
    // Returning to /try with work already here must not seed a second empty note on top
    // of it, so startGuest only seeds when the store is empty.
    const { noteId } = startGuest();
    setTarget(noteId ? `/note/${noteId}` : '/');
  }, [user]);

  if (user) return <Navigate to="/" replace />;

  if (blocked) {
    return (
      <div className="auth-splash" role="alert">
        <div style={{ maxWidth: 420, textAlign: 'center', padding: 24, lineHeight: 1.6 }}>
          <p>
            This browser will not let Unote store anything, so there is nowhere to keep notes you write
            without an account. Private browsing is the usual cause.
          </p>
          <p>
            <a href="/signup">Make an account instead</a>
          </p>
        </div>
      </div>
    );
  }

  if (!target) return null;
  // isGuest() is already true by now, so the shell's guard lets this through.
  return isGuest() ? <Navigate to={target} replace /> : null;
}
