// Entry point for /capture, and the reason phone capture can work at all.
//
// /capture used to sit behind the ordinary <RequireAuth>. That guard is correct for every
// other page and fatal for this one: the whole premise is a phone that has never signed
// in, so scanning the QR always landed on /login. The page was unreachable by the only
// device it was built for.
//
// The QR now carries a single-use pairing code. This component spends it - once, before
// anything else renders - for a capture-scoped session, then falls back to the normal
// guard for anyone arriving at /capture without a code (a desktop user opening the page
// directly, which is a supported way to use the drag-and-drop fallback).
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import RequireAuth from '../auth/RequireAuth';
import { ApiError } from '../../lib/api';
import CapturePage from './CapturePage';
import Spinner from '../../components/Spinner';
import './CapturePage.css';

type Phase = 'redeeming' | 'failed' | 'ready';

export default function CaptureRoute() {
  const { user, pair } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const code = params.get('pair');

  // Only a device with no session redeems. A desktop user who happens to open a pairing
  // link while signed in must NOT have their full session swapped for a capture-scoped
  // one - that would silently downgrade the browser they do their actual work in.
  const shouldRedeem = Boolean(code) && !user;
  const [phase, setPhase] = useState<Phase>(shouldRedeem ? 'redeeming' : 'ready');
  const [error, setError] = useState<string | null>(null);
  /**
   * The in-flight redemption, held across effect re-runs.
   *
   * A pairing code may be spent exactly once, so this cannot simply re-run. But a plain
   * "already tried" boolean is not enough either: StrictMode mounts, cleans up and remounts
   * the effect, and the naive version deadlocks - the first run's cleanup suppresses its own
   * state update, while the second run sees the boolean and returns without registering any.
   * The result is a phone that has successfully paired (the POST returns 200) sitting on the
   * "Pairing this phone…" spinner forever.
   *
   * Storing the PROMISE instead means the second run subscribes to the same redemption
   * rather than skipping it, so exactly one request is made and whichever run is mounted
   * last is the one that renders the outcome.
   */
  const pending = useRef<Promise<void> | null>(null);

  useEffect(() => {
    if (!code) return;

    // Strip the code from the address bar whatever happens next. It is a live credential;
    // leaving it in the URL puts it in browser history, in a screenshot of the phone, and
    // in anything the user might paste or share. `replace` so Back does not restore it.
    const clearUrl = () => navigate('/capture', { replace: true });

    if (!shouldRedeem) {
      clearUrl();
      return;
    }

    let active = true;
    if (!pending.current) pending.current = pair(code);
    pending.current
      .then(() => {
        if (active) setPhase('ready');
      })
      .catch((e: unknown) => {
        if (!active) return;
        setError(
          e instanceof ApiError
            ? e.message
            : 'Could not pair this phone. Check your connection and scan the code again.',
        );
        setPhase('failed');
      })
      .finally(() => {
        if (active) clearUrl();
      });

    return () => {
      active = false;
    };
  }, [code, shouldRedeem, pair, navigate]);

  if (phase === 'redeeming') {
    return (
      <div className="cp-page cp-page--message">
        <div className="cp-message" role="status">
          <Spinner size={28} />
          <p>Pairing this phone…</p>
        </div>
      </div>
    );
  }

  if (phase === 'failed') {
    return (
      <div className="cp-page cp-page--message">
        <div className="cp-message" role="alert">
          <h2>Couldn't pair this phone</h2>
          <p>{error}</p>
          <p className="cp-message__hint">
            Capture codes last a few minutes and work once. Open Phone capture on your computer
            again for a fresh code.
          </p>
        </div>
      </div>
    );
  }

  // No code, or a code already spent: the ordinary rules apply. A paired phone now has a
  // session, so this passes; a stranger opening /capture cold still goes to /login.
  return (
    <RequireAuth>
      <CapturePage />
    </RequireAuth>
  );
}
