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
  const snapshotRef = useRef<Notebook[]>([]);

  useEffect(() => {
    snapshotRef.current = notebooks;
  }, [notebooks]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { notebooks: list } = await api.notebooks();
      setNotebooks([...list].sort((a, b) => a.position - b.position));
    } catch (e) {
      setError(errorMessage(e, 'Could not load notebooks'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const createNotebook = useCallback(async (b: { name: string; emoji?: string; color?: string }) => {
    const { notebook } = await api.createNotebook(b);
    setNotebooks((cur) => [...cur, notebook].sort((a, b2) => a.position - b2.position));
    return notebook;
  }, []);

  const updateNotebook = useCallback(
    async (id: string, b: Partial<Pick<Notebook, 'name' | 'emoji' | 'color' | 'position' | 'archived'>>) => {
      setNotebooks((cur) => cur.map((n) => (n.id === id ? { ...n, ...b } : n)));
      try {
        const { notebook } = await api.updateNotebook(id, b);
        setNotebooks((cur) => cur.map((n) => (n.id === id ? notebook : n)));
        return notebook;
      } catch (e) {
        setNotebooks(snapshotRef.current);
        throw e;
      }
    },
    [],
  );

  const deleteNotebook = useCallback(async (id: string) => {
    setNotebooks((cur) => cur.filter((n) => n.id !== id));
    try {
      await api.deleteNotebook(id);
    } catch (e) {
      setNotebooks(snapshotRef.current);
      throw e;
    }
  }, []);

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
