// templates-nb — extracts heading text from a template's contentJson for the picker's
// mini "skeleton preview" card. Walks the WHOLE tree (not just top-level children) so
// headings nested inside columns/details (Cornell's columnList, Lecture's toggle) are
// still found.
type TTNode = { type?: string; text?: string; attrs?: Record<string, unknown>; content?: TTNode[] };

export interface HeadingPreviewItem {
  level: number;
  text: string;
}

function textOf(node: TTNode | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.text ?? '';
  if (Array.isArray(node.content)) return node.content.map(textOf).join('');
  return '';
}

export function extractHeadings(doc: unknown, max = 5): HeadingPreviewItem[] {
  const out: HeadingPreviewItem[] = [];

  function walk(node: unknown): void {
    if (out.length >= max || !node || typeof node !== 'object') return;
    const n = node as TTNode;
    if (n.type === 'heading') {
      out.push({ level: (n.attrs?.level as number) ?? 1, text: textOf(n).trim() || 'Heading' });
    }
    if (Array.isArray(n.content)) {
      for (const child of n.content) {
        if (out.length >= max) break;
        walk(child);
      }
    }
  }

  walk(doc);
  return out;
}
