// The `sketch` node: an atomic block that embeds a draw surface directly in a note.
//
// Atom (leaf) node — it has no editable ProseMirror children; its entire content is the
// vector strokes held in the `strokes` attr and drawn by SketchView. That mirrors how the
// stock image node works, and is why renderHTML emits a self-closing element (no `0`
// content hole, unlike the Callout block).
//
// Persistence: the strokes live in `strokes`, which the editor autosaves as part of the
// note's content JSON. The attr's parseHTML/renderHTML additionally serialise them to a
// data-attribute so copy/paste and HTML export keep the drawing (see sketchModel.ts for
// why vectors-in-attrs is the chosen scheme).

import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import SketchView from './SketchView';
import {
  clampWorldH,
  deserializeStrokes,
  normalizeBg,
  serializeStrokes,
  SKETCH_WORLD_H_DEFAULT,
  type SketchStroke,
} from './sketchModel';

export interface SketchOptions {
  HTMLAttributes: Record<string, unknown>;
}

/** Read a JSON blob from a data attribute, tolerating anything malformed. */
function parseStrokesAttr(value: string | null): SketchStroke[] {
  if (!value) return [];
  try {
    // Round-trip through the shared defensive parser so a hand-edited or truncated blob
    // degrades to an empty pad rather than poisoning the node.
    return serializeStrokes(deserializeStrokes(JSON.parse(value)));
  } catch {
    return [];
  }
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    sketch: {
      /** Insert an empty sketch pad at the current selection. */
      insertSketch: () => ReturnType;
    };
  }
}

const SketchNode = Node.create<SketchOptions>({
  name: 'sketch',
  group: 'block',
  atom: true,
  selectable: true,
  // Not draggable: the surface owns pointer events for drawing, so a drag-to-move handle
  // over it would fight the pen. It is still selectable/deletable via the gap cursor.
  draggable: false,

  addOptions() {
    return { HTMLAttributes: {} };
  },

  addAttributes() {
    return {
      strokes: {
        default: [] as SketchStroke[],
        parseHTML: (el) => parseStrokesAttr(el.getAttribute('data-strokes')),
        renderHTML: (attrs) => ({ 'data-strokes': JSON.stringify(attrs.strokes ?? []) }),
      },
      h: {
        default: SKETCH_WORLD_H_DEFAULT,
        parseHTML: (el) => clampWorldH(Number(el.getAttribute('data-h'))),
        renderHTML: (attrs) => ({ 'data-h': clampWorldH(attrs.h) }),
      },
      bg: {
        default: 'dots',
        parseHTML: (el) => normalizeBg(el.getAttribute('data-bg')),
        renderHTML: (attrs) => ({ 'data-bg': normalizeBg(attrs.bg) }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="sketch"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        'data-type': 'sketch',
        class: 'folio-sketch',
      }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(SketchView);
  },

  addCommands() {
    return {
      insertSketch:
        () =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { strokes: [], h: SKETCH_WORLD_H_DEFAULT, bg: 'dots' } }),
    };
  },
});

export default SketchNode;
