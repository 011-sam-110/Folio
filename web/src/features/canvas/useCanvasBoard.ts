// The board's document: items, connectors, and the write-behind persistence that
// keeps them on the server without ever putting a request in a pointermove.
//
// Two rules shape this file:
//
//  1. LOCAL STATE IS AUTHORITATIVE DURING INTERACTION. A drag mutates React state
//     every frame and the network not at all; the bulk PATCH goes out once, on
//     commit, debounced. The PATCH response is intentionally discarded rather
//     than merged, because by the time it lands the user may already be dragging
//     again and echoing the server's older positions back would fight the pointer.
//
//  2. IDS ARE NOT STABLE ACROSS UNDO. The API cannot create an item at a chosen
//     id, so undoing a delete produces a NEW id. Rather than rewriting every
//     queued undo entry, entries address items through `resolve()`, which walks a
//     remap table. That keeps a ten-deep undo history correct through repeated
//     undo/redo cycles.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { toast } from '../../components/Toast';
import { errorMessage } from '../../lib/format';
import type { CanvasEdge, CanvasItem, CanvasItemData, CanvasItemKind } from '../../lib/types';

const PATCH_DEBOUNCE_MS = 350;

const ITEM_KINDS: CanvasItemKind[] = ['sticky', 'text', 'image', 'shape', 'link'];

export type ItemPatch = { id: string } & Partial<Pick<CanvasItem, 'x' | 'y' | 'width' | 'height' | 'rotation' | 'z' | 'data'>>;

export interface NewItemSpec {
  kind: CanvasItemKind;
  x: number;
  y: number;
  width: number;
  height: number;
  data?: CanvasItemData;
}

export interface CanvasBoardDoc {
  items: CanvasItem[];
  edges: CanvasEdge[];
  status: 'loading' | 'ready' | 'error';
  error: string;
  reload: () => void;

  /** Follow the undo remap chain for an id captured earlier. */
  resolve: (id: string) => string;

  /** Apply patches to local state immediately; persistence is debounced+batched. */
  patchLocal: (patches: readonly ItemPatch[]) => void;
  /** Persist the given patches (merged into the pending batch). */
  queuePatch: (patches: readonly ItemPatch[]) => void;

  createItems: (specs: readonly NewItemSpec[]) => Promise<CanvasItem[]>;
  destroyItems: (ids: readonly string[]) => void;
  /** Re-create items (and any edges between them) after an undo. */
  restore: (items: readonly CanvasItem[], edges: readonly CanvasEdge[]) => Promise<void>;

  createEdge: (from: string, to: string) => Promise<CanvasEdge | null>;
  destroyEdge: (id: string) => void;

  /** Push out any pending PATCH now. */
  flush: () => Promise<void>;
}

export function useCanvasBoard(noteId: string): CanvasBoardDoc {
  const [items, setItems] = useState<CanvasItem[]>([]);
  const [edges, setEdges] = useState<CanvasEdge[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');

  const pendingRef = useRef<Map<string, ItemPatch>>(new Map());
  const timerRef = useRef<number | null>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const remapRef = useRef<Map<string, string>>(new Map());
  const loadSeqRef = useRef(0);

  const resolve = useCallback((id: string): string => {
    let cur = id;
    // Bounded walk: a cycle would otherwise hang the UI, and a chain longer than
    // this means something has gone wrong that a spin will not fix.
    for (let i = 0; i < 32; i++) {
      const next = remapRef.current.get(cur);
      if (!next) return cur;
      cur = next;
    }
    return cur;
  }, []);

  const load = useCallback(() => {
    const seq = ++loadSeqRef.current;
    setStatus('loading');
    api
      .canvas(noteId)
      .then(({ items: gotItems, edges: gotEdges }) => {
        if (loadSeqRef.current !== seq) return;
        setItems(gotItems.map(normalizeItem).filter((i): i is CanvasItem => i !== null));
        setEdges(gotEdges.filter((e) => e && e.from && e.to));
        setStatus('ready');
      })
      .catch((e: unknown) => {
        if (loadSeqRef.current !== seq) return;
        setError(errorMessage(e, 'Could not load this canvas'));
        setStatus('error');
      });
  }, [noteId]);

  useEffect(() => {
    load();
    return () => {
      loadSeqRef.current++;
    };
  }, [load]);

  const sendPending = useCallback(async (): Promise<void> => {
    if (pendingRef.current.size === 0) return;
    const batch = [...pendingRef.current.values()];
    pendingRef.current.clear();
    const run = (async () => {
      try {
        // ONE request for the whole batch — this is why the drag handler never
        // touches the network.
        await api.updateCanvasItems(noteId, batch);
      } catch {
        // Re-queue, but let anything newer for the same id win: the newer value
        // is what the user is currently looking at.
        for (const p of batch) if (!pendingRef.current.has(p.id)) pendingRef.current.set(p.id, p);
        toast('Canvas changes not saved, retrying', 'error');
      }
    })();
    inFlightRef.current = run;
    await run;
    if (inFlightRef.current === run) inFlightRef.current = null;
  }, [noteId]);

  const queuePatch = useCallback(
    (patches: readonly ItemPatch[]) => {
      for (const p of patches) {
        const id = resolve(p.id);
        const prev = pendingRef.current.get(id);
        pendingRef.current.set(id, prev ? { ...prev, ...p, id } : { ...p, id });
      }
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        void sendPending();
      }, PATCH_DEBOUNCE_MS);
    },
    [resolve, sendPending],
  );

  const flush = useCallback(async () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    await inFlightRef.current;
    await sendPending();
  }, [sendPending]);

  useEffect(() => {
    return () => {
      // Unmounting mid-debounce would drop the last drag; fire it without awaiting.
      void flush();
    };
  }, [flush]);

  const patchLocal = useCallback(
    (patches: readonly ItemPatch[]) => {
      if (patches.length === 0) return;
      const byId = new Map(patches.map((p) => [resolve(p.id), p]));
      setItems((prev) =>
        prev.map((it) => {
          const p = byId.get(it.id);
          if (!p) return it;
          const { id: _ignored, ...rest } = p;
          return { ...it, ...rest };
        }),
      );
    },
    [resolve],
  );

  const createItems = useCallback(
    async (specs: readonly NewItemSpec[]): Promise<CanvasItem[]> => {
      if (specs.length === 0) return [];
      try {
        const created = await Promise.all(
          specs.map((s) =>
            api
              .createCanvasItem(noteId, { kind: s.kind, x: s.x, y: s.y, width: s.width, height: s.height, data: s.data ?? {} })
              .then((r) => normalizeItem(r.item)),
          ),
        );
        const ok = created.filter((i): i is CanvasItem => i !== null);
        setItems((prev) => [...prev, ...ok]);
        return ok;
      } catch (e) {
        toast(errorMessage(e, 'Could not add to the canvas'), 'error');
        return [];
      }
    },
    [noteId],
  );

  const destroyItems = useCallback(
    (ids: readonly string[]) => {
      const real = ids.map(resolve);
      const idSet = new Set(real);
      setItems((prev) => prev.filter((i) => !idSet.has(i.id)));
      // The server cascades edges when an item goes; mirror that locally so the
      // connector layer does not render a stub to a card that is gone.
      setEdges((prev) => prev.filter((e) => !idSet.has(e.from) && !idSet.has(e.to)));
      for (const id of real) {
        pendingRef.current.delete(id);
        api.deleteCanvasItem(noteId, id).catch(() => {});
      }
    },
    [noteId, resolve],
  );

  const restore = useCallback(
    async (toRestore: readonly CanvasItem[], edgesToRestore: readonly CanvasEdge[]) => {
      if (toRestore.length === 0 && edgesToRestore.length === 0) return;
      try {
        const created = await Promise.all(
          toRestore.map((it) =>
            api
              .createCanvasItem(noteId, { kind: it.kind, x: it.x, y: it.y, width: it.width, height: it.height, data: it.data })
              .then((r) => ({ old: it.id, item: normalizeItem(r.item) })),
          ),
        );
        const fresh: CanvasItem[] = [];
        for (const { old, item } of created) {
          if (!item) continue;
          // Record the identity change so every queued undo entry that still
          // names the old id keeps working.
          remapRef.current.set(old, item.id);
          fresh.push(item);
        }
        // z is assigned server-side on insert (always "on top"), so push the
        // originals back in one bulk PATCH to preserve the stacking the user had.
        const zPatches = created
          .filter((c): c is { old: string; item: CanvasItem } => c.item !== null)
          .map(({ old, item }) => {
            const src = toRestore.find((t) => t.id === old);
            return src ? { id: item.id, z: src.z } : null;
          })
          .filter((p): p is { id: string; z: number } => p !== null);
        if (zPatches.length > 0) {
          setItems((prev) => [...prev, ...fresh].map((i) => {
            const p = zPatches.find((zp) => zp.id === i.id);
            return p ? { ...i, z: p.z } : i;
          }));
          queuePatch(zPatches);
        } else {
          setItems((prev) => [...prev, ...fresh]);
        }

        // Edges last, and through resolve(), so their endpoints point at the
        // freshly-minted item ids rather than the dead ones.
        for (const e of edgesToRestore) {
          const from = resolve(e.from);
          const to = resolve(e.to);
          try {
            const { edge } = await api.createCanvasEdge(noteId, { from, to, label: e.label, style: e.style });
            remapRef.current.set(e.id, edge.id);
            setEdges((prev) => [...prev, edge]);
          } catch {
            // An endpoint that no longer exists is an expected loss here, not a
            // failure worth interrupting the user over.
          }
        }
      } catch (e) {
        toast(errorMessage(e, 'Could not undo that'), 'error');
      }
    },
    [noteId, resolve, queuePatch],
  );

  const createEdge = useCallback(
    async (from: string, to: string): Promise<CanvasEdge | null> => {
      try {
        const { edge } = await api.createCanvasEdge(noteId, { from: resolve(from), to: resolve(to), style: 'arrow' });
        setEdges((prev) => [...prev, edge]);
        return edge;
      } catch (e) {
        toast(errorMessage(e, 'Could not connect those'), 'error');
        return null;
      }
    },
    [noteId, resolve],
  );

  const destroyEdge = useCallback(
    (id: string) => {
      const real = resolve(id);
      setEdges((prev) => prev.filter((e) => e.id !== real));
      api.deleteCanvasEdge(noteId, real).catch(() => {});
    },
    [noteId, resolve],
  );

  return {
    items,
    edges,
    status,
    error,
    reload: load,
    resolve,
    patchLocal,
    queuePatch,
    createItems,
    destroyItems,
    restore,
    createEdge,
    destroyEdge,
    flush,
  };
}

/** The `data` column is opaque JSON and `kind` is a free-text column, so a row
 *  written by a future (or buggy) client must not be able to crash the board. */
function normalizeItem(raw: CanvasItem): CanvasItem | null {
  if (!raw || typeof raw.id !== 'string') return null;
  const kind = ITEM_KINDS.includes(raw.kind) ? raw.kind : 'sticky';
  const n = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    id: raw.id,
    kind,
    x: n(raw.x, 0),
    y: n(raw.y, 0),
    width: Math.max(24, n(raw.width, 220)),
    height: Math.max(24, n(raw.height, 160)),
    rotation: n(raw.rotation, 0),
    z: n(raw.z, 0),
    data: raw.data && typeof raw.data === 'object' ? raw.data : {},
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}
