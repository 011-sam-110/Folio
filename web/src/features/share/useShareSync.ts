// Delta-polling sync for a shared note.
//
// WHY POLLING AND NOT A SOCKET: Folio's API runs as Vercel serverless functions,
// which cannot hold a WebSocket open. The server therefore exposes a monotonic
// change feed (note_events) and clients ask "what has happened since revision N".
// That is a real constraint, not a shortcut, and the UI says so rather than
// implying keystroke-level sync.
//
// ECHO SUPPRESSION. Every event carries an `actor` — a user id for the owner, an
// opaque guest id otherwise. The share API never tells a client its OWN actor id
// (GET /note returns `you`, a display name, which is not unique), so actor
// matching only works for a signed-in owner reading their own link. Everything
// else is suppressed downstream instead, and exactly:
//   * ink  — by stroke id (useSharedInk.pullRemote skips ids it already knows)
//   * doc  — by content equality (SharedDoc ignores a pull identical to its own
//            document, so our own echo can never move the caret)
// Those checks are stronger than actor matching, because they also survive the
// case where our own event and someone else's arrive in the same batch.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import type { ShareEvent } from '../../lib/types';

/** Foreground cadence. Fast enough to feel collaborative, slow enough that a
 *  handful of people on one board is a trickle of requests rather than a flood. */
export const POLL_VISIBLE_MS = 2500;
/** Background cadence. A tab left open for hours must not keep hammering the
 *  server; presence still refreshes often enough to not look dead on return. */
export const POLL_HIDDEN_MS = 30_000;

export interface Presence {
  name: string;
  color: string;
}

export interface ShareSync {
  /** Highest event sequence this client has consumed. */
  revision: number;
  presence: Presence[];
  /** When the last successful poll landed — drives the "updated Ns ago" chip. */
  lastSyncAt: Date | null;
  /** True once a poll has failed; cleared by the next success. */
  offline: boolean;
  /** Poll immediately (after our own write, or when the tab is re-focused). */
  pollNow: () => void;
}

export interface ShareSyncHandlers {
  /** A doc event landed that we did not obviously cause. */
  onDoc?: (events: ShareEvent[]) => void;
  /** Ink was written. `ids` is the union of every id across the batch. */
  onInk?: (ids: string[]) => void;
}

export function useShareSync(
  token: string,
  initialRevision: number,
  handlers: ShareSyncHandlers,
  /** The signed-in user's id, when the viewer happens to own the note. Lets us
   *  drop our own events before they cost a refetch. Guests pass undefined. */
  selfActor?: string,
): ShareSync {
  const [revision, setRevision] = useState(initialRevision);
  const [presence, setPresence] = useState<Presence[]>([]);
  const [lastSyncAt, setLastSyncAt] = useState<Date | null>(null);
  const [offline, setOffline] = useState(false);

  // Handlers change identity every render; a ref keeps the poll loop from being
  // torn down and rebuilt (which would reset the interval) on each parent render.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const revisionRef = useRef(initialRevision);
  const timerRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);
  const selfActorRef = useRef(selfActor);
  selfActorRef.current = selfActor;

  const poll = useCallback(async () => {
    // One request at a time. A slow response must not let the interval stack up
    // requests that then land out of order and rewind `revision`.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const res = await api.shareEvents(token, revisionRef.current);
      setOffline(false);
      setLastSyncAt(new Date());
      setPresence(res.presence);

      if (res.events.length > 0) {
        // The server echoes `since` back as `revision` when nothing is new, so
        // this only ever moves forward.
        revisionRef.current = Math.max(revisionRef.current, res.revision);
        setRevision(revisionRef.current);

        const self = selfActorRef.current;
        const foreign = self ? res.events.filter((e) => e.actor !== self) : res.events;
        if (foreign.length === 0) return;

        const docEvents = foreign.filter((e) => e.kind === 'doc');
        if (docEvents.length > 0) handlersRef.current.onDoc?.(docEvents);

        const inkIds = foreign
          .filter((e) => e.kind === 'ink')
          .flatMap((e) => (Array.isArray(e.payload?.ids) ? (e.payload.ids as string[]) : []));
        if (inkIds.length > 0) handlersRef.current.onInk?.(inkIds);
      }
    } catch {
      // A failed poll is not fatal — the next tick retries from the same
      // revision, so no delta is ever skipped.
      setOffline(true);
    } finally {
      inFlightRef.current = false;
    }
  }, [token]);

  const pollNow = useCallback(() => {
    void poll();
  }, [poll]);

  // The loop itself. Re-armed whenever visibility flips, so a hidden tab drops to
  // the slow cadence instead of polling as if someone were watching it.
  useEffect(() => {
    let cadence = document.visibilityState === 'hidden' ? POLL_HIDDEN_MS : POLL_VISIBLE_MS;

    const arm = () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      timerRef.current = window.setInterval(() => void poll(), cadence);
    };

    const onVisibility = () => {
      const next = document.visibilityState === 'hidden' ? POLL_HIDDEN_MS : POLL_VISIBLE_MS;
      if (next === cadence) return;
      cadence = next;
      arm();
      // Coming back to the tab should show the truth immediately rather than
      // after a full interval of staring at stale content.
      if (document.visibilityState === 'visible') void poll();
    };

    void poll();
    arm();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [poll]);

  return { revision, presence, lastSyncAt, offline, pollNow };
}
