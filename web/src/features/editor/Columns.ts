// Side-by-side layout: a `columnList` node holding 2-4 `column` nodes, each a normal
// block container. JSON contract (shared with templates-nb's Cornell template, see
// docs/ITER2-PLAN.md): `{ type: 'columnList', content: [{ type: 'column',
// attrs: { width: null }, content: [blocks…] }] }`. Rendered as a responsive CSS grid
// (editor.css) that collapses to a stacked layout under 640px. Column-boundary dragging
// (resizing individual widths) is intentionally NOT implemented — the spec calls it
// optional and it's the flakiest part of this pattern to get right; `width` is carried
// in the schema for a future pass but unused today (all columns render equal-width).
import { Node, mergeAttributes } from '@tiptap/core';
import { Selection, type EditorState } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/core';

export interface ColumnsOptions {
  HTMLAttributes: Record<string, unknown>;
}

/** Depth of the nearest ancestor `column` node containing `$from`, or -1 if none. */
function findColumnDepth(state: EditorState): number {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === 'column') return d;
  }
  return -1;
}

function handleColumnBackspace(editor: Editor): boolean {
  const { state } = editor;
  const { selection } = state;
  if (!selection.empty) return false;
  const { $from } = selection;

  const columnDepth = findColumnDepth(state);
  if (columnDepth === -1) return false;
  // Only fires right at the start of the column's own content — a plain Backspace
  // elsewhere inside the column (e.g. mid-paragraph, or a second block down) should
  // behave exactly like it would anywhere else in the doc.
  if ($from.pos !== $from.start(columnDepth)) return false;

  const columnNode = $from.node(columnDepth);
  const isEmptyColumn =
    columnNode.childCount === 0 ||
    (columnNode.childCount === 1 &&
      !!columnNode.firstChild &&
      columnNode.firstChild.isTextblock &&
      columnNode.firstChild.content.size === 0);
  if (!isEmptyColumn) return false;

  const columnListDepth = columnDepth - 1;
  if (columnListDepth < 0) return false;
  const columnListNode = $from.node(columnListDepth);
  if (columnListNode.type.name !== 'columnList') return false;
  if (columnListNode.childCount <= 1) return false; // shouldn't happen (min 2 columns), just a safety guard

  const columnListPos = $from.before(columnListDepth);
  const colIndex = $from.index(columnListDepth);
  const { tr } = state;

  if (columnListNode.childCount === 2) {
    // Removing this column leaves exactly one — unwrap the whole columnList, replacing
    // it with the remaining column's own block content directly (sequential blocks,
    // per the "degrades to sequential blocks" contract in ITER2-PLAN.md).
    const otherColumn = columnListNode.child(colIndex === 0 ? 1 : 0);
    tr.replaceWith(columnListPos, columnListPos + columnListNode.nodeSize, otherColumn.content);
    tr.setSelection(Selection.near(tr.doc.resolve(Math.min(columnListPos, tr.doc.content.size))));
  } else {
    const colStart = $from.before(columnDepth);
    const colEnd = $from.after(columnDepth);
    tr.delete(colStart, colEnd);
    tr.setSelection(Selection.near(tr.doc.resolve(Math.min(colStart, tr.doc.content.size))));
  }
  editor.view.dispatch(tr);
  return true;
}

function handleColumnTab(editor: Editor, dir: 1 | -1): boolean {
  const { state } = editor;
  const columnDepth = findColumnDepth(state);
  if (columnDepth === -1) return false;
  const { $from } = state.selection;
  const columnListDepth = columnDepth - 1;
  const columnListNode = $from.node(columnListDepth);
  if (columnListNode.type.name !== 'columnList') return false;

  const colIndex = $from.index(columnListDepth);
  const targetIndex = colIndex + dir;
  if (targetIndex < 0 || targetIndex >= columnListNode.childCount) return false; // let Tab fall through at the edges

  const columnListStart = $from.start(columnListDepth);
  let offset = 0;
  for (let i = 0; i < targetIndex; i++) offset += columnListNode.child(i).nodeSize;
  // +1 steps past the target column's own opening token, landing inside its content.
  const targetPos = Math.min(columnListStart + offset + 1, state.doc.content.size);

  const $target = state.doc.resolve(targetPos);
  const sel = Selection.near($target, 1);
  editor.view.dispatch(state.tr.setSelection(sel));
  editor.view.focus();
  return true;
}

export const Column = Node.create<ColumnsOptions>({
  name: 'column',
  content: 'block+',
  isolating: true,

  addOptions() {
    return { HTMLAttributes: {} };
  },

  addAttributes() {
    return {
      width: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-width'),
        renderHTML: (attrs) => (attrs.width ? { 'data-width': attrs.width as string } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="column"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { 'data-type': 'column', class: 'folio-column' }), 0];
  },

  addKeyboardShortcuts() {
    return {
      Tab: () => handleColumnTab(this.editor, 1),
      'Shift-Tab': () => handleColumnTab(this.editor, -1),
      Backspace: () => handleColumnBackspace(this.editor),
    };
  },
});

export const ColumnList = Node.create<ColumnsOptions>({
  name: 'columnList',
  group: 'block',
  content: 'column{2,4}',
  defining: true,
  isolating: true,

  addOptions() {
    return { HTMLAttributes: {} };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="columnList"]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const count = node.childCount || 2;
    return [
      'div',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        'data-type': 'columnList',
        'data-count': String(count),
        class: 'folio-columns',
        style: `--folio-column-count:${count}`,
      }),
      0,
    ];
  },
});

/** Builds a fresh N-column `columnList` doc fragment for the slash menu / templates. */
export function buildColumnsContent(count: 2 | 3 | 4): Record<string, unknown> {
  return {
    type: 'columnList',
    content: Array.from({ length: count }, () => ({
      type: 'column',
      attrs: { width: null },
      content: [{ type: 'paragraph' }],
    })),
  };
}
