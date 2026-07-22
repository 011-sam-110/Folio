// The shared session itself: header chrome + the right surface for the note kind,
// with the poll loop that keeps them in step.
//
// The header is where this feature is honest about what it is. Collaboration here
// is delta-polling, not a socket, so the chip says "Synced Ns ago" with a real
// timestamp instead of a green "Live" dot that would imply something the
// transport cannot deliver.

import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from '../../components/Icon';
import Tooltip from '../../components/Tooltip';
import { Toaster } from '../../components/Toast';
import { useTheme } from '../../lib/theme';
import { useAuth } from '../auth/AuthContext';
import type { SharedNote } from '../../lib/types';
import { DeadLink } from './ShareShell';
import SharedBoard from './SharedBoard';
import SharedDoc from './SharedDoc';
import { POLL_VISIBLE_MS, useShareSync } from './useShareSync';
import { useSharedInk } from './useSharedInk';
import './share.css';

export interface SharedViewProps {
  token: string;
  /** Loaded by JoinPage, so the session starts from the server's truth rather
   *  than anything inferred from the pre-auth peek or the join response. */
  initial: SharedNote;
}

export default function SharedView({ token, initial }: SharedViewProps) {
  const isCanvas = initial.note.kind === 'canvas';
  const canEdit = initial.canEdit;
  const [theme, , toggleTheme] = useTheme();
  const [title, setTitle] = useState(initial.note.title);
  // The signed-in user, when there is one. Only the owner of the note can be
  // signed in AND reading a share link, and their events carry their user id as
  // `actor` - which is the one case where the feed's own echo suppression works.
  // A guest has no id it can compare against; see useShareSync for the rest.
  const { user } = useAuth();

  const ink = useSharedInk(token, canEdit && isCanvas);

  // SharedDoc registers its puller here; the sync loop calls it on a doc event.
  const docHandlerRef = useRef<() => void>(() => {});
  const registerDocHandler = useCallback((fn: () => void) => {
    docHandlerRef.current = fn;
  }, []);

  const inkRef = useRef(ink);
  inkRef.current = ink;

  const sync = useShareSync(
    token,
    initial.revision,
    {
      onDoc: () => docHandlerRef.current(),
      onInk: (ids) => void inkRef.current.pullRemote(ids),
    },
    user?.id,
  );

  useEffect(() => {
    document.title = `${title || 'Untitled'} · Shared on Unote`;
  }, [title]);

  const others = sync.presence.filter((p) => p.name !== initial.you);
  const kindLabel = isCanvas ? 'Whiteboard' : 'Note';

  // Access withdrawn mid-session. Taking over the screen is the honest move:
  // leaving the stale document visible behind a "reconnecting" chip implies it
  // is still live and still theirs to edit, and any edit they make from here is
  // silently discarded by the server.
  if (sync.lost) return <DeadLink midSession />;

  return (
    <div className="sh-session">
      <header className="sh-header">
        <span className="sh-header__mark" aria-hidden="true">
          📓
        </span>
        <span className="sh-header__title" title={title}>
          {title || 'Untitled'}
        </span>
        <span className="sh-header__badge">
          <Icon name={isCanvas ? 'canvas' : 'file-text'} size={12} /> {kindLabel}
        </span>
        <span className={`sh-header__badge sh-header__badge--${canEdit ? 'edit' : 'view'}`}>
          {canEdit ? 'You can edit' : 'View only'}
        </span>

        <div className="sh-header__spacer" />

        <Presence you={initial.you} others={others} />
        <SyncChip lastSyncAt={sync.lastSyncAt} offline={sync.offline} onRefresh={sync.pollNow} />

        <button
          type="button"
          className="icon-btn"
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          onClick={toggleTheme}
        >
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={15} />
        </button>
      </header>

      {isCanvas ? (
        <>
          <SharedBoard ink={ink} canEdit={canEdit} />
          {/* Said once, at the top of the board, because a guest who expects the
              owner's stickies to be here would otherwise think the board failed
              to load. */}
          <p className="sh-session__note">
            Shared boards carry the drawing layer only. Stickies and cards stay with the owner.
          </p>
        </>
      ) : (
        <SharedDoc
          token={token}
          initial={initial}
          onSaved={sync.pollNow}
          registerDocHandler={registerDocHandler}
          onTitleChange={setTitle}
        />
      )}

      <Toaster />
    </div>
  );
}

function Presence({ you, others }: { you: string; others: Array<{ name: string; color: string }> }) {
  return (
    <div className="sh-presence" aria-label="People on this link">
      <Tooltip content={`You are here as “${you}”`}>
        <span className="sh-presence__chip sh-presence__chip--you">{you}</span>
      </Tooltip>
      {others.slice(0, 4).map((p) => (
        <Tooltip key={`${p.name}-${p.color}`} content={`${p.name} was active in the last minute`}>
          <span className="sh-presence__chip" style={{ borderColor: p.color, color: p.color }}>
            {p.name}
          </span>
        </Tooltip>
      ))}
      {others.length > 4 && <span className="sh-presence__more">+{others.length - 4}</span>}
    </div>
  );
}

/**
 * The honesty chip.
 *
 * Vercel's serverless functions cannot hold a WebSocket, so there is no live
 * connection to report the state of - only the age of the last poll. Showing
 * that age (and the real interval behind it) is the difference between a user
 * who waits two seconds and one who assumes the feature is broken.
 */
function SyncChip({
  lastSyncAt,
  offline,
  onRefresh,
}: {
  lastSyncAt: Date | null;
  offline: boolean;
  onRefresh: () => void;
}) {
  const [, force] = useState(0);
  // The chip renders an elapsed time, which nothing else would re-render.
  useEffect(() => {
    const id = window.setInterval(() => force((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  const seconds = lastSyncAt ? Math.max(0, Math.round((Date.now() - lastSyncAt.getTime()) / 1000)) : null;
  const label = offline
    ? 'Reconnecting…'
    : seconds === null
      ? 'Connecting…'
      : seconds < 5
        ? 'Synced just now'
        : `Synced ${seconds}s ago`;

  return (
    <Tooltip
      content={`Changes are fetched every ${Math.round(POLL_VISIBLE_MS / 1000)}s, not instantly. Click to check now.`}
    >
      <button
        type="button"
        className={`sh-sync${offline ? ' is-offline' : ''}`}
        onClick={onRefresh}
        aria-label="Check for changes now"
      >
        <Icon name="refresh" size={12} />
        {label}
      </button>
    </Tooltip>
  );
}
