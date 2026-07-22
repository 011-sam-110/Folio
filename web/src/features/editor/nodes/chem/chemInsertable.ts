// Insert-menu descriptor for the Chemistry structure block. Section 'Notation' (alongside
// math). The InsertItem / InsertSection types below match the shared editor contract; they
// are declared locally so this module typechecks standalone, and the parent's structurally
// identical InsertItem accepts `chemInsertable` when it is wired into the Insert menu.
import type { Editor } from '@tiptap/core';

export type InsertSection = 'Basic' | 'Lists' | 'Notation' | 'Media' | 'Layout' | 'Advanced';

export interface InsertItem {
  id: string;
  title: string;
  description: string;
  icon: string;
  section: InsertSection;
  keywords?: string[];
  run: (editor: Editor, range?: { from: number; to: number }) => void;
}

export const chemInsertable: InsertItem = {
  id: 'chem',
  title: 'Chemistry structure',
  description: 'Draw or type a molecule (SMILES)',
  icon: '⬡',
  section: 'Notation',
  keywords: [
    'chemistry',
    'molecule',
    'smiles',
    'structure',
    'organic',
    'compound',
    'bond',
    'reaction',
    'chem',
  ],
  // Handles both call shapes: with a range (delete the "/" query first), or without (insert
  // at the current selection).
  run: (editor, range) => {
    const chain = editor.chain().focus();
    if (range) chain.deleteRange(range);
    chain.insertContent({ type: 'chem', attrs: { smiles: '', name: '', molfile: null } }).run();
  },
};

export default chemInsertable;
