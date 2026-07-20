// `/join/:token` — the guest entry point. Public: mounted OUTSIDE RequireAuth,
// because the whole point is that the person opening it has no Folio account.
//
// Three states, in order:
//   1. peek    GET /share/:token tells us the title, the kind and whether there
//              is a password — and nothing else. A visitor who cannot clear the
//              gate never learns anything about the note's contents or its owner.
//   2. gate    ask for a display name (+ the password, if one is set) and POST
//              /join, which sets a per-share httpOnly cookie.
//   3. session hand off to SharedView.
//
// Step 2 is skipped when GET /note already answers 200 — that is a returning
// guest whose cookie is still valid, or the owner opening their own link. Making
// them retype a name they already chose would be pointless friction.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import Icon from '../../components/Icon';
import Spinner from '../../components/Spinner';
import { api, ApiError } from '../../lib/api';
import { errorMessage } from '../../lib/format';
import type { SharePeek, SharedNote } from '../../lib/types';
import { DeadLink, ShareShell } from './ShareShell';
import SharedView from './SharedView';
import './share.css';

/** Remembering the last name used means a student who opens three of a
 *  classmate's links does not type it three times. */
const NAME_KEY = 'folio:guestName';

type Phase = 'loading' | 'gate' | 'session' | 'dead';

export default function JoinPage() {
  const { token = '' } = useParams<{ token: string }>();
  const [phase, setPhase] = useState<Phase>('loading');
  const [peek, setPeek] = useState<SharePeek | null>(null);
  const [session, setSession] = useState<SharedNote | null>(null);
  const [deadReason, setDeadReason] = useState('');

  useEffect(() => {
    let cancelled = false;
    setPhase('loading');

    (async () => {
      let peeked: SharePeek;
      try {
        peeked = await api.sharePeek(token);
      } catch (e) {
        if (cancelled) return;
        // 404 is the server's single answer for invalid / expired / revoked — it
        // deliberately does not distinguish them, so neither do we.
        setDeadReason(
          e instanceof ApiError && e.status === 404
            ? ''
            : errorMessage(e, 'Something went wrong opening this link'),
        );
        setPhase('dead');
        return;
      }
      if (cancelled) return;
      setPeek(peeked);

      // Already inside? (valid guest cookie, or this is the owner.)
      try {
        const already = await api.sharedNote(token);
        if (cancelled) return;
        setSession(already);
        setPhase('session');
      } catch {
        if (cancelled) return;
        setPhase('gate');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token]);

  const onJoined = useCallback((loaded: SharedNote) => {
    setSession(loaded);
    setPhase('session');
  }, []);

  if (phase === 'loading') {
    return (
      <ShareShell>
        <div className="sh-join__loading" role="status">
          <Spinner size={22} />
          <span>Opening the link…</span>
        </div>
      </ShareShell>
    );
  }

  if (phase === 'dead') return <DeadLink reason={deadReason || undefined} />;

  if (phase === 'session' && session) {
    return <SharedView token={token} initial={session} />;
  }

  if (phase === 'gate' && peek) {
    return <JoinGate token={token} peek={peek} onJoined={onJoined} />;
  }

  return null;
}

function JoinGate({
  token,
  peek,
  onJoined,
}: {
  token: string;
  peek: SharePeek;
  onJoined: (n: SharedNote) => void;
}) {
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem(NAME_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const passwordRef = useRef<HTMLInputElement | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api.shareJoin(token, {
        displayName: name.trim() || undefined,
        ...(peek.needsPassword ? { password } : {}),
      });
      try {
        localStorage.setItem(NAME_KEY, name.trim());
      } catch {
        // Private mode — the name just won't be remembered.
      }
      // Load through the same call the session uses, so the view starts from the
      // server's truth rather than anything inferred from the join response.
      onJoined(await api.sharedNote(token));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError('That password isn’t right.');
        setPassword('');
        passwordRef.current?.focus();
      } else if (err instanceof ApiError && err.status === 404) {
        setError('This link has expired or been revoked.');
      } else {
        setError(errorMessage(err, 'Could not join — try again'));
      }
      setBusy(false);
    }
  }

  const what = peek.kind === 'canvas' ? 'whiteboard' : 'note';

  return (
    <ShareShell>
      <h1 className="sh-card__title">{peek.title || 'Untitled'}</h1>
      <p className="sh-card__subtitle">
        You’ve been invited to a Folio {what}
        {peek.permission === 'edit' ? ' you can edit' : ' to read'}. No account needed.
      </p>

      <form className="sh-gate" onSubmit={submit}>
        {/* The hint sits OUTSIDE the <label> and is wired up with aria-describedby.
            Nested inside it, it would be concatenated into the field's accessible
            name, so a screen reader would announce the whole sentence as the name
            of the box every time focus landed there. */}
        <div className="sh-field">
          <label className="sh-field__label" htmlFor="sh-join-name">
            Your name
          </label>
          <input
            id="sh-join-name"
            className="text-input"
            value={name}
            autoFocus
            maxLength={40}
            placeholder="How others will see you"
            autoComplete="nickname"
            aria-describedby="sh-join-name-hint"
            onChange={(e) => setName(e.target.value)}
          />
          <span className="sh-field__hint" id="sh-join-name-hint">
            Shown to everyone else on this {what}. Leave blank to join as “Guest”.
          </span>
        </div>

        {peek.needsPassword && (
          <div className="sh-field">
            <label className="sh-field__label" htmlFor="sh-join-password">
              <Icon name="lock" size={12} /> Password
            </label>
            <input
              id="sh-join-password"
              ref={passwordRef}
              className="text-input"
              type="password"
              value={password}
              autoComplete="off"
              placeholder="Set by whoever shared this"
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
        )}

        {error && (
          <p className="sh-gate__error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="btn btn-primary sh-gate__submit" disabled={busy}>
          {busy && <Spinner size={13} />}
          {busy ? 'Joining…' : `Open ${what}`}
        </button>
      </form>
    </ShareShell>
  );
}
