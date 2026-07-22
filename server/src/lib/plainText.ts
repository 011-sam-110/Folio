/**
 * Flatten a TipTap document to plain text.
 *
 * `notes.content_text` is what full-text search indexes, what card snippets read,
 * and what the AI endpoints send as context - so any write path that updates
 * `content_json` without also updating this leaves the note editable but
 * unsearchable, with a stale snippet. That is exactly what happened on the share
 * route: a guest could type into a shared note and nothing they wrote was ever
 * findable. Shared here so both write paths derive it identically rather than one
 * of them quietly forgetting.
 */
export function plainTextFromDoc(doc: unknown): string {
  const out: string[] = [];

  function walk(node: unknown): void {
    if (!node || typeof node !== 'object') return;
    const n = node as {
      type?: string;
      text?: string;
      attrs?: Record<string, unknown>;
      content?: unknown[];
    };
    if (n.type === 'text') {
      out.push(n.text ?? '');
      return;
    }
    // Wikilinks are stored as nodes but must survive into the text as [[Title]],
    // because link resolution re-parses content_text to rebuild the link graph.
    if (n.type === 'wikilink' || n.type === 'wikiLink') {
      out.push(`[[${(n.attrs?.title ?? n.attrs?.label ?? '') as string}]]`);
      return;
    }
    if (n.type === 'hardBreak') {
      out.push('\n');
      return;
    }
    if (Array.isArray(n.content)) for (const c of n.content) walk(c);
    if (
      n.type &&
      ['paragraph', 'heading', 'listItem', 'taskItem', 'codeBlock', 'tableRow', 'blockquote', 'detailsSummary'].includes(
        n.type,
      )
    ) {
      out.push('\n');
    }
  }

  walk(doc);
  return out.join('').replace(/\n{2,}/g, '\n').trim();
}
