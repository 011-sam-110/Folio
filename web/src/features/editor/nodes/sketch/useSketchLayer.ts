// An InkLayer backed by a TipTap node's attrs instead of the server.
//
// canvas/InkSurface is deliberately persistence-agnostic: it talks only to the InkLayer
// interface ("knows nothing about boards, notes or persistence"). The board + doc-overlay
// use canvas/useInkLayer, which POSTs to /api/canvas/:noteId/ink (the note_ink table). An
// inline sketch must NOT do that - every sketch in a note would pile into one note-level
// ink layer. So we implement the SAME interface here, writing strokes straight into the
// node's `strokes` attr, which the editor already autosaves as part of the note's content.
//
// This is the whole reuse story: same drawing surface, same renderer (canvas/strokes.ts),
// same undo stack - only the storage seam is swapped.

import { useCallback, useRef, useState } from 'react';
import type { InkLayer } from '../../../canvas/useInkLayer';
import type { LocalStroke } from '../../../canvas/strokes';
import { deserializeStrokes, nextSketchId, serializeStrokes, type SketchStroke } from './sketchModel';

export function useSketchLayer(
  initialAttr: unknown,
  onChange: (strokes: SketchStroke[]) => void,
): InkLayer {
  // Seed ONCE from the attr. After mount our React state is authoritative; the attr is a
  // write-behind mirror. We never re-seed from an incoming prop, which is what stops the
  // updateAttributes() we fire on each stroke from looping back in as a fresh seed.
  const [strokes, setStrokes] = useState<LocalStroke[]>(() => deserializeStrokes(initialAttr));
  const ref = useRef(strokes);
  ref.current = strokes;

  const commit = useCallback(
    (next: LocalStroke[]) => {
      ref.current = next;
      setStrokes(next);
      onChange(serializeStrokes(next));
    },
    [onChange],
  );

  const addStroke = useCallback(
    (stroke: Omit<LocalStroke, 'id' | 'pending'>): LocalStroke => {
      const local: LocalStroke = { ...stroke, id: nextSketchId() };
      commit([...ref.current, local]);
      return local;
    },
    [commit],
  );

  const removeStrokes = useCallback(
    (ids: readonly string[]): LocalStroke[] => {
      if (ids.length === 0) return [];
      const idSet = new Set(ids);
      const removed = ref.current.filter((s) => idSet.has(s.id));
      if (removed.length === 0) return [];
      commit(ref.current.filter((s) => !idSet.has(s.id)));
      return removed;
    },
    [commit],
  );

  const restoreStrokes = useCallback(
    (toRestore: readonly LocalStroke[]): LocalStroke[] => {
      if (toRestore.length === 0) return [];
      // New ids on restore - the erased originals' ids are gone, and an undo entry that
      // reused them would collide with a later stroke.
      const revived = toRestore.map((s) => ({ ...s, id: nextSketchId() }));
      commit([...ref.current, ...revived]);
      return revived;
    },
    [commit],
  );

  const clearAll = useCallback(async () => {
    commit([]);
  }, [commit]);

  // Attrs are written synchronously through the editor transaction, so there is never a
  // pending network batch to flush - but the interface requires it.
  const flush = useCallback(async () => {}, []);

  return { strokes, ready: true, addStroke, removeStrokes, restoreStrokes, clearAll, flush };
}
