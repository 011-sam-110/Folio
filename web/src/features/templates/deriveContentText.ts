// templates-nb — plain-text projection of a TipTap doc.
//
// Creating a note from a template happens client-side (docs/API.md): we POST both
// contentJson AND contentText to /api/notes. contentText can't just be left out and
// deferred to the server, because notes.ts (owned by another agent this wave) is not
// ours to extend — so this mirrors its `plainTextFallback` walk exactly, on the client,
// which keeps search/snippets/word-count consistent regardless of which path created
// the note.
type TTNode = { type?: string; text?: string; attrs?: Record<string, unknown>; content?: TTNode[] };

const NEWLINE_AFTER = new Set([
  'paragraph', 'heading', 'listItem', 'taskItem', 'codeBlock', 'tableRow', 'blockquote', 'detailsSummary',
]);

export function deriveContentText(doc: unknown): string {
  const out: string[] = [];

  function walk(node: unknown): void {
    if (!node || typeof node !== 'object') return;
    const n = node as TTNode;

    if (n.type === 'text') {
      out.push(n.text ?? '');
      return;
    }
    if (n.type === 'wikilink' || n.type === 'wikiLink') {
      out.push(`[[${(n.attrs?.title ?? n.attrs?.label ?? '') as string}]]`);
      return;
    }
    if (n.type === 'hardBreak') {
      out.push('\n');
      return;
    }
    if (Array.isArray(n.content)) {
      for (const child of n.content) walk(child);
    }
    if (n.type && NEWLINE_AFTER.has(n.type)) out.push('\n');
  }

  walk(doc);
  return out.join('').replace(/\n{2,}/g, '\n').trim();
}
