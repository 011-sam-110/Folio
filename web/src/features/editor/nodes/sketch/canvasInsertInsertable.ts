// Insert item: "Insert from canvas" — a STATIC snapshot of one of the student's boards.
//
// FUTURE (live-linking): v1 inserts a frozen image. A later iteration could store the
// source board id on a dedicated figure node and re-render the snapshot when the board
// changes (or on note open), turning the frozen image into a live view. That needs a new
// schema-backed node + a refresh path, so it is intentionally out of scope here.

import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Editor } from '@tiptap/core';
import { focusFrom, type InsertItem } from './insertTypes';
import CanvasInsertModal from './CanvasInsertModal';

/** Mount the board picker on its own detached root — no shared modal host to wire up. */
export function openCanvasInsertModal(editor: Editor): void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const cleanup = () => {
    root.unmount();
    container.remove();
  };
  root.render(createElement(CanvasInsertModal, { editor, onDone: cleanup }));
}

export const canvasInsertInsertable: InsertItem = {
  id: 'canvas-snapshot',
  title: 'Insert from canvas',
  description: 'Add a snapshot of one of your boards',
  icon: '🖼️',
  section: 'Notation',
  keywords: ['canvas', 'board', 'snapshot', 'whiteboard', 'diagram', 'image', 'sketch'],
  run: (editor, range) => {
    // Clear the "/query" span (if any) before the modal opens, so the picker isn't sitting
    // behind a stale slash query.
    focusFrom(editor, range).run();
    openCanvasInsertModal(editor);
  },
};

export default canvasInsertInsertable;
