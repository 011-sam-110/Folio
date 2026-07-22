// Custom block node: a 2D molecular structure. The molecule is stored as TEXT ONLY -
// a SMILES string (always), plus an optional molfile when the Draw editor produced one,
// plus an optional human name. No binary, no attachment: the whole node round-trips through
// the note's content_json. Rendering is done offline in the node view (see smilesRenderer).
import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import ChemView from './ChemView';

export interface ChemOptions {
  HTMLAttributes: Record<string, unknown>;
}

export const ChemNode = Node.create<ChemOptions>({
  name: 'chem',
  group: 'block',
  // Self-contained block: no editable child content, all state lives in attrs.
  atom: true,
  draggable: true,
  selectable: true,

  addOptions() {
    return { HTMLAttributes: {} };
  },

  addAttributes() {
    return {
      // The canonical persisted value. Empty string is valid (renders the friendly empty state).
      smiles: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-smiles') || '',
        renderHTML: (attrs) => ({ 'data-smiles': (attrs.smiles as string) ?? '' }),
      },
      // Best-effort common name (display + search). Optional.
      name: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-name') || '',
        renderHTML: (attrs) => (attrs.name ? { 'data-name': attrs.name as string } : {}),
      },
      // Present only when the structure came from the Draw editor (MDL molfile text).
      molfile: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-molfile') || null,
        renderHTML: (attrs) => (attrs.molfile ? { 'data-molfile': attrs.molfile as string } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="chem"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    // Atom node: no content hole. The persisted attrs live on data-* so a copied/exported
    // note still carries the molecule even without the React view mounted.
    return [
      'div',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { 'data-type': 'chem', class: 'folio-chem' }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ChemView);
  },
});

export default ChemNode;
