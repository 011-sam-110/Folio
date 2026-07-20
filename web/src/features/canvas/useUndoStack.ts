// A plain command stack. Each entry carries its own inverse, which suits a canvas
// far better than snapshotting the whole board: a board can hold hundreds of items
// plus thousands of ink points, and snapshot-per-keystroke would be both large and
// slow to diff back to the API.
//
// Entries are closures over an id-remapping ref (see useCanvasBoard), so an entry
// stays valid even after undo/redo has caused the server to reissue ids.

import { useCallback, useRef, useState } from 'react';

export interface UndoEntry {
  /** Shown in the "Undid X" toast, so phrase it as a noun: "move", "3 items". */
  label: string;
  undo: () => void;
  redo: () => void;
}

const LIMIT = 100;

export interface UndoStack {
  push: (entry: UndoEntry) => void;
  undo: () => UndoEntry | null;
  redo: () => UndoEntry | null;
  canUndo: boolean;
  canRedo: boolean;
  clear: () => void;
}

export function useUndoStack(): UndoStack {
  const undoRef = useRef<UndoEntry[]>([]);
  const redoRef = useRef<UndoEntry[]>([]);
  // Mirrors the stack depths purely so the toolbar buttons can disable — the
  // stacks themselves stay in refs because they are read inside event handlers
  // that must not be rebuilt on every push.
  const [depths, setDepths] = useState({ u: 0, r: 0 });
  const sync = useCallback(() => setDepths({ u: undoRef.current.length, r: redoRef.current.length }), []);

  const push = useCallback(
    (entry: UndoEntry) => {
      undoRef.current.push(entry);
      if (undoRef.current.length > LIMIT) undoRef.current.shift();
      // Any new action invalidates the redo branch — standard linear-history
      // behaviour, and the only one that cannot surprise the user.
      redoRef.current = [];
      sync();
    },
    [sync],
  );

  const undo = useCallback(() => {
    const entry = undoRef.current.pop();
    if (!entry) return null;
    entry.undo();
    redoRef.current.push(entry);
    sync();
    return entry;
  }, [sync]);

  const redo = useCallback(() => {
    const entry = redoRef.current.pop();
    if (!entry) return null;
    entry.redo();
    undoRef.current.push(entry);
    sync();
    return entry;
  }, [sync]);

  const clear = useCallback(() => {
    undoRef.current = [];
    redoRef.current = [];
    sync();
  }, [sync]);

  return { push, undo, redo, canUndo: depths.u > 0, canRedo: depths.r > 0, clear };
}
