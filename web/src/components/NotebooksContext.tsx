// web-shell — shared notebook list + mutations, consumed by Sidebar and
// NotebookPage (and anything else in the shell that needs a live list
// without an extra round trip). Dashboard/editor get notebook info from
// their own dedicated endpoints per docs/API.md and don't need this.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import type { Notebook } from '../lib/types';
import { errorMessage } from '../lib/format';

export interface NotebooksState {
  notebooks: Notebook[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  createNotebook: (b: { name: string; emoji?: string; color?: string }) => Promise<Notebook>;
  updateNotebook: (
    id: string,
    b: Partial<Pick<Notebook, 'name' | 'emoji' | 'color' | 'position' | 'archived'>>,
  ) => Promise<Notebook>;
  deleteNotebook: (id: string) => Promise<void>;
}

const NotebooksCtx = createContext<NotebooksState | null>(null);

export function NotebooksProvider({ children }: { children: ReactNode }) {
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Mirror of the latest committed list, updated synchronously inside every setNotebooks —
  // used to capture a PRE-mutation snapshot for rollback. (The old useEffect-based snapshot
  // refreshed AFTER the optimistic update committed, so "rollback" re-applied the failed
  // state and a failed delete looked permanent.)
  const latestRef = useRef<Notebook[]>([]);
  const commit = useCallback((updater: (cur: Notebook[]) => Notebook[]) => {
    setNotebooks((cur) => {
      const next = updater(cur);
      latestRef.current = next;
      return next;
    });
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { notebooks: list } = await api.notebooks();
      commit(() => [...list].sort((a, b) => a.position - b.position));
    } catch (e) {
      setError(errorMessage(e, 'Could not load notebooks'));
    } finally {
      setLoading(false);
    }
  }, [commit]);

  useEffect(() => {
    reload();
  }, [reload]);

  const createNotebook = useCallback(async (b: { name: string; emoji?: string; color?: string }) => {
    const { notebook } = await api.createNotebook(b);
    commit((cur) => [...cur, notebook].sort((a, b2) => a.position - b2.position));
    return notebook;
  }, [commit]);

  const updateNotebook = useCallback(
    async (id: string, b: Partial<Pick<Notebook, 'name' | 'emoji' | 'color' | 'position' | 'archived'>>) => {
      const prev = latestRef.current; // captured BEFORE the optimistic mutation
      commit((cur) => cur.map((n) => (n.id === id ? { ...n, ...b } : n)));
      try {
        const { notebook } = await api.updateNotebook(id, b);
        commit((cur) => cur.map((n) => (n.id === id ? notebook : n)));
        return notebook;
      } catch (e) {
        commit(() => prev);
        throw e;
      }
    },
    [commit],
  );

  const deleteNotebook = useCallback(async (id: string) => {
    const prev = latestRef.current; // captured BEFORE the optimistic mutation
    commit((cur) => cur.filter((n) => n.id !== id));
    try {
      await api.deleteNotebook(id);
    } catch (e) {
      commit(() => prev);
      throw e;
    }
  }, [commit]);

  return (
    <NotebooksCtx.Provider value={{ notebooks, loading, error, reload, createNotebook, updateNotebook, deleteNotebook }}>
      {children}
    </NotebooksCtx.Provider>
  );
}

export function useNotebooks(): NotebooksState {
  const ctx = useContext(NotebooksCtx);
  if (!ctx) throw new Error('useNotebooks must be used within <NotebooksProvider>');
  return ctx;
}
