// Computes the live heading outline of a document for the OutlinePane.
import type { Editor } from '@tiptap/core';

export interface OutlineItem {
  id: string;
  level: number;
  text: string;
  pos: number;
}

export function computeOutline(editor: Editor): OutlineItem[] {
  const items: OutlineItem[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      items.push({
        id: (node.attrs.id as string) || `h-${pos}`,
        level: (node.attrs.level as number) || 1,
        text: node.textContent.trim() || 'Untitled',
        pos,
      });
    }
  });
  return items;
}
