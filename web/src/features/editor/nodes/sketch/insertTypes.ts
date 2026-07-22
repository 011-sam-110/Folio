// The Insert-menu descriptor contract.
//
// This is a LOCAL copy of the shared `InsertItem` contract so this module type-checks
// and ships on its own, before the parent session's Insert-menu foundation lands. It is
// intentionally identical in shape to the contract in the task brief; because TypeScript
// is structural, the two `InsertItem` exports are interchangeable - the parent can either
// import these consts as-is or re-point the annotations at its own canonical type without
// touching any runtime code.

import type { Editor } from '@tiptap/core';

export type InsertSection = 'Basic' | 'Lists' | 'Notation' | 'Media' | 'Layout' | 'Advanced';

export interface InsertItem {
  id: string;
  title: string;
  description: string;
  /** An emoji (content-identity glyph), matching the existing slash-menu items. */
  icon: string;
  section: InsertSection;
  keywords?: string[];
  /**
   * `range` is the "/query" span that opened the menu. When present the caller expects
   * it deleted before anything is inserted; when absent, insert at the current selection.
   */
  run: (editor: Editor, range?: { from: number; to: number }) => void;
}

/**
 * Delete the trigger range (if any) and hand back a focused chain to continue from.
 * Mirrors SlashItems.ts's private `del()` so both insert paths behave identically whether
 * they were reached from the slash menu (range set) or a toolbar (range undefined).
 */
export function focusFrom(editor: Editor, range?: { from: number; to: number }) {
  const chain = editor.chain().focus();
  return range ? chain.deleteRange(range) : chain;
}
