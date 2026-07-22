// Debounced autosave: schedules a PATCH 800ms after the last change, tracks a small
// status machine for the chip UI, and flushes on demand (unmount / blur / Ctrl+S / beforeunload).
//
// Correctness invariants (each backs a specific data-integrity bug):
//  - The dirty flag is cleared ONLY after a save is confirmed 2xx AND no edit landed while it
//    was in flight - a failed save keeps the note dirty so unmount/beforeunload still retry it.
//  - A flush() that arrives while a save is in flight queues a follow-up instead of returning
//    the older save's promise, so the newest keystrokes are never silently dropped.
//  - Failed saves auto-retry with capped backoff, and the chip reflects saving/saved/error.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import type { Note } from '../../lib/types';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export interface AutosavePayload {
  title: string;
  contentJson: unknown;
  contentText: string;
  /** Explicit chips ∪ body #hashtags. Riding in the same payload (rather than a
   *  separate PATCH) is what makes tag edits share the debounce, the retry/backoff
   *  and the beforeunload keepalive already proven for title and content. */
  tags?: string[];
}

const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 30_000;

export function useAutosave(noteId: string, getPayload: () => AutosavePayload | null, onSaved?: (note: Note) => void) {
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, forceTick] = useState(0);

  const timerRef = useRef<number | undefined>(undefined);
  const retryTimerRef = useRef<number | undefined>(undefined);
  const retryDelayRef = useRef(RETRY_BASE_MS);
  const dirtyRef = useRef(false);
  // Monotonic edit counter - lets a completing save tell whether an edit landed mid-flight
  // (in which case the note is still dirty and must be saved again).
  const editSeqRef = useRef(0);
  const flushingRef = useRef<Promise<void> | null>(null);
  const getPayloadRef = useRef(getPayload);
  getPayloadRef.current = getPayload;
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const noteIdRef = useRef(noteId);
  noteIdRef.current = noteId;

  const flush = useCallback((): Promise<void> => {
    window.clearTimeout(timerRef.current);
    window.clearTimeout(retryTimerRef.current);
    // A save is already running - chain a follow-up so newer edits aren't lost, rather than
    // handing back the in-flight promise (which is bound to the OLDER payload).
    if (flushingRef.current) {
      return flushingRef.current.then(() => (dirtyRef.current ? flush() : undefined));
    }
    if (!dirtyRef.current) return Promise.resolve();
    const payload = getPayloadRef.current();
    if (!payload) return Promise.resolve();

    const savedSeq = editSeqRef.current; // edits captured by THIS save
    setStatus('saving');
    const run = (async (): Promise<boolean> => {
      try {
        const { note } = await api.updateNote(noteIdRef.current, payload);
        setStatus('saved');
        setSavedAt(new Date());
        setError(null);
        retryDelayRef.current = RETRY_BASE_MS;
        // Only mark clean if nothing changed while we were saving.
        if (editSeqRef.current === savedSeq) dirtyRef.current = false;
        onSavedRef.current?.(note);
        return true;
      } catch (e) {
        // Keep the note dirty so unmount / beforeunload still try to persist it, and
        // auto-retry with capped backoff.
        setStatus('error');
        setError(e instanceof Error ? e.message : 'Save failed');
        const delay = retryDelayRef.current;
        retryDelayRef.current = Math.min(delay * 2, RETRY_MAX_MS);
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = window.setTimeout(() => {
          if (dirtyRef.current) void flush();
        }, delay);
        return false;
      } finally {
        flushingRef.current = null;
      }
    })();
    flushingRef.current = run.then(() => undefined);
    // Follow-up save ONLY after a success that left newer edits unsaved. A failure must
    // NOT chain here (the backoff timer owns retries) or a persistent failure would
    // hot-loop PATCHes with no delay.
    return run.then((ok) => (ok && dirtyRef.current ? flush() : undefined));
  }, []);

  const schedule = useCallback(() => {
    dirtyRef.current = true;
    editSeqRef.current += 1;
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      void flush();
    }, 800);
  }, [flush]);

  // Refresh the "Saved · Xm ago" label every 30s without a real save.
  useEffect(() => {
    const id = window.setInterval(() => forceTick((t) => t + 1), 30000);
    return () => window.clearInterval(id);
  }, []);

  // Best-effort flush when the tab is closing (keepalive fetch - sendBeacon can't set JSON headers reliably).
  useEffect(() => {
    function handleBeforeUnload() {
      if (!dirtyRef.current) return;
      const payload = getPayloadRef.current();
      if (!payload) return;
      try {
        fetch(`/api/notes/${noteIdRef.current}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          keepalive: true,
        }).catch(() => {});
      } catch {
        // ignore
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  // Flush on unmount (e.g. navigating to another note).
  useEffect(() => {
    return () => {
      window.clearTimeout(retryTimerRef.current);
      if (dirtyRef.current) void flush();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reset dirty accounting when the note being edited changes (defensive - callers key the
  // workspace on note id, but a same-id remount must not carry a stale dirty flag).
  const markClean = useCallback(() => {
    dirtyRef.current = false;
    window.clearTimeout(timerRef.current);
    window.clearTimeout(retryTimerRef.current);
    setStatus('saved');
    setError(null);
  }, []);

  /** Wait for any in-flight save to finish WITHOUT triggering a new one. */
  const settle = useCallback((): Promise<void> => {
    return flushingRef.current ? flushingRef.current.then(() => undefined) : Promise.resolve();
  }, []);

  return { status, savedAt, error, schedule, flush, settle, markClean, isDirty: () => dirtyRef.current };
}
