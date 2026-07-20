// Ink state + persistence for a note reached through a SHARE LINK.
//
// This is a sibling of features/canvas/useInkLayer.ts, not a wrapper around it,
// because the share API is a genuinely different contract: it exposes only
// GET /ink and POST /ink. There is no DELETE and no clear, so the shared layer is
// APPEND-ONLY. Trying to reuse the owner hook would have meant a transport
// abstraction whose remove/clear arms are dead on one of the two implementations,
// and an eraser in the toolbar that silently un-erases on the next reload.
//
// The other thing this hook owns that the owner's does not: pulling in strokes
// OTHER people drew. The delta feed reports an `ink` event carrying the stroke
// ids that were just written; `pullRemote` decides whether any of them are new to
// us and, if so, refetches the layer and appends only the unseen ones.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { toast } from '../../components/Toast';
import type { InkStroke } from '../../lib/types';
import type { LocalStroke } from '../canvas/strokes';
import type { InkLayer } from '../canvas/useInkLayer';

/** Debounce before uploading a burst of finished strokes — matches the owner
 *  layer, and is deliberately shorter than the sync poll so a stroke is on the
 *  server before the next poll goes looking for it. */
const UPLOAD_DEBOUNCE_MS = 600;

export interface SharedInkLayer extends InkLayer {
  /**
   * Called when the delta feed reports an ink write. Returns true if anything
   * was actually pulled in, so the caller can surface "someone drew".
   *
   * THIS IS THE ECHO SUPPRESSION. Every id we have ever seen — whether we drew it
   * or fetched it — is in `knownRef`, so our own strokes coming back around the
   * loop are recognised and the refetch is skipped entirely. That works without
   * knowing our own actor id, which the share API never tells us.
   */
  pullRemote: (ids: readonly string[]) => Promise<boolean>;
}

let tempSeq = 0;
const nextTempId = () => `tmp-shink-${++tempSeq}`;

export function useSharedInk(token: string, canEdit: boolean): SharedInkLayer {
  const [strokes, setStrokes] = useState<LocalStroke[]>([]);
  const [ready, setReady] = useState(false);

  // Every stroke id this client is aware of, local or remote.
  const knownRef = useRef<Set<string>>(new Set());
  // Finished but not yet uploaded, in draw order — the POST returns ids
  // positionally, so the order is load-bearing.
  const queueRef = useRef<LocalStroke[]>([]);
  const timerRef = useRef<number | null>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const loadSeqRef = useRef(0);
  // Serialises pullRemote against itself: two ink events landing in quick
  // succession would otherwise both GET and both append the same strokes.
  const pullingRef = useRef<Promise<boolean> | null>(null);

  useEffect(() => {
    const seq = ++loadSeqRef.current;
    setReady(false);
    api
      .sharedInk(token)
      .then(({ strokes: fetched }) => {
        if (loadSeqRef.current !== seq) return;
        const normalized = fetched.map(normalizeStroke).filter((s): s is LocalStroke => s !== null);
        for (const s of normalized) knownRef.current.add(s.id);
        setStrokes(normalized);
        setReady(true);
      })
      .catch(() => {
        if (loadSeqRef.current !== seq) return;
        // An empty-looking layer would invite drawing over ink you cannot see, so
        // a failed load stays "not ready" rather than pretending the board is blank.
        toast('Could not load the drawing on this board', 'error');
        setReady(false);
      });
    return () => {
      loadSeqRef.current++;
    };
  }, [token]);

  const upload = useCallback(async (): Promise<void> => {
    const batch = queueRef.current;
    if (batch.length === 0) return;
    queueRef.current = [];

    const run = (async () => {
      try {
        const { ids } = await api.addSharedInk(
          token,
          batch.map((s) => ({ points: s.points, color: s.color, width: s.width, tool: s.tool })),
        );
        const mapping = new Map<string, string>();
        batch.forEach((s, i) => {
          if (ids[i]) {
            mapping.set(s.id, ids[i]);
            // Record the real id BEFORE it can come back through the feed.
            knownRef.current.add(ids[i]);
          }
        });
        setStrokes((prev) =>
          prev.map((s) => {
            const real = mapping.get(s.id);
            return real ? { ...s, id: real, pending: false } : s;
          }),
        );
      } catch {
        // Put the batch back rather than lose strokes the user can still see.
        queueRef.current = [...batch, ...queueRef.current];
        toast('Drawing not saved yet — retrying', 'error');
      }
    })();

    inFlightRef.current = run;
    await run;
    if (inFlightRef.current === run) inFlightRef.current = null;
  }, [token]);

  const scheduleUpload = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void upload();
    }, UPLOAD_DEBOUNCE_MS);
  }, [upload]);

  const flush = useCallback(async () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    await inFlightRef.current;
    await upload();
  }, [upload]);

  // Last-chance save: ink has no other persistence path, so a tab closed inside
  // the debounce window would otherwise drop the final strokes.
  useEffect(() => {
    if (!canEdit) return;
    const onHide = () => {
      if (queueRef.current.length === 0) return;
      const batch = queueRef.current;
      queueRef.current = [];
      try {
        navigator.sendBeacon?.(
          `/api/share/${token}/ink`,
          new Blob(
            [
              JSON.stringify({
                strokes: batch.map((s) => ({ points: s.points, color: s.color, width: s.width, tool: s.tool })),
              }),
            ],
            { type: 'application/json' },
          ),
        );
      } catch {
        // The page is going away; nothing further is possible.
      }
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      onHide();
    };
  }, [token, canEdit]);

  const addStroke = useCallback(
    (stroke: Omit<LocalStroke, 'id' | 'pending'>): LocalStroke => {
      const local: LocalStroke = { ...stroke, id: nextTempId(), pending: true };
      setStrokes((prev) => [...prev, local]);
      queueRef.current.push(local);
      scheduleUpload();
      return local;
    },
    [scheduleUpload],
  );

  const pullRemote = useCallback(
    async (ids: readonly string[]): Promise<boolean> => {
      const unseen = ids.filter((id) => !knownRef.current.has(id));
      if (unseen.length === 0) return false; // our own echo, or already merged
      if (pullingRef.current) return pullingRef.current;

      const run = (async () => {
        try {
          const { strokes: fetched } = await api.sharedInk(token);
          const fresh: LocalStroke[] = [];
          for (const raw of fetched) {
            if (knownRef.current.has(raw.id)) continue;
            const s = normalizeStroke(raw);
            if (!s) continue;
            knownRef.current.add(s.id);
            fresh.push(s);
          }
          if (fresh.length === 0) return false;
          // Append rather than replace: our own not-yet-uploaded strokes still
          // carry temp ids and are not in the server's answer, and replacing
          // would make them vanish from under the pen.
          setStrokes((prev) => [...prev, ...fresh]);
          return true;
        } catch {
          return false; // the next ink event retries
        }
      })();

      pullingRef.current = run;
      const result = await run;
      if (pullingRef.current === run) pullingRef.current = null;
      return result;
    },
    [token],
  );

  // Append-only API: these exist to satisfy the InkLayer contract that InkSurface
  // is written against. The shared toolbar hides the eraser and the clear button,
  // so nothing reaches them — but a silent no-op would be a trap if that ever
  // changed, hence the toast.
  const removeStrokes = useCallback((): LocalStroke[] => {
    toast('Erasing is not available on a shared board', 'info');
    return [];
  }, []);

  const restoreStrokes = useCallback(
    (toRestore: readonly LocalStroke[]): LocalStroke[] => {
      if (toRestore.length === 0) return [];
      const revived = toRestore.map((s) => ({ ...s, id: nextTempId(), pending: true }));
      setStrokes((prev) => [...prev, ...revived]);
      queueRef.current.push(...revived);
      scheduleUpload();
      return revived;
    },
    [scheduleUpload],
  );

  const clearAll = useCallback(async () => {
    toast('Clearing is not available on a shared board', 'info');
  }, []);

  return { strokes, ready, addStroke, removeStrokes, restoreStrokes, clearAll, flush, pullRemote };
}

/** Defensive read of a server stroke — the stroke column is opaque JSON, so a row
 *  written by an older client must degrade to null and be skipped, not crash. */
function normalizeStroke(s: InkStroke): LocalStroke | null {
  if (!s || !Array.isArray(s.points) || s.points.length === 0) return null;
  const points = s.points.filter(
    (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]),
  );
  if (points.length === 0) return null;
  return {
    id: s.id,
    points: points.map((p) => [p[0], p[1], Number.isFinite(p[2]) ? p[2] : 0.5]),
    color: typeof s.color === 'string' ? s.color : '#1f2328',
    width: Number.isFinite(s.width) ? s.width : 3,
    tool: s.tool === 'highlighter' ? 'highlighter' : 'pen',
  };
}
