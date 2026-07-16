// Debounced autosave: schedules a PATCH 800ms after the last change, tracks a small
// status machine for the chip UI, and flushes on demand (unmount / blur / Ctrl+S / beforeunload).
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import type { Note } from '../../lib/types';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export interface AutosavePayload {
  title: string;
  contentJson: unknown;
  contentText: string;
}

export function useAutosave(noteId: string, getPayload: () => AutosavePayload | null, onSaved?: (note: Note) => void) {
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, forceTick] = useState(0);

  const timerRef = useRef<number | undefined>(undefined);
  const dirtyRef = useRef(false);
  const flushingRef = useRef<Promise<void> | null>(null);
  const getPayloadRef = useRef(getPayload);
  getPayloadRef.current = getPayload;
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const noteIdRef = useRef(noteId);
  noteIdRef.current = noteId;

  const flush = useCallback((): Promise<void> => {
    window.clearTimeout(timerRef.current);
    if (flushingRef.current) return flushingRef.current;
    const payload = getPayloadRef.current();
    if (!payload) return Promise.resolve();
    dirtyRef.current = false;
    setStatus('saving');
    const run = (async () => {
      try {
        const { note } = await api.updateNote(noteIdRef.current, payload);
        setStatus('saved');
        setSavedAt(new Date());
        setError(null);
        onSavedRef.current?.(note);
      } catch (e) {
        setStatus('error');
        setError(e instanceof Error ? e.message : 'Save failed');
      } finally {
        flushingRef.current = null;
      }
    })();
    flushingRef.current = run;
    return run;
  }, []);

  const schedule = useCallback(() => {
    dirtyRef.current = true;
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

  // Best-effort flush when the tab is closing (keepalive fetch — sendBeacon can't set JSON headers reliably).
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
      if (dirtyRef.current) void flush();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { status, savedAt, error, schedule, flush, isDirty: () => dirtyRef.current };
}
