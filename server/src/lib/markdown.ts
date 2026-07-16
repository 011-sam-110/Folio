// Markdown <-> TipTap conversion used by imports (extracted/AI text becomes a real
// editable note) and by the seed script. Pipeline: marked (md -> HTML, with a small
// renderer patch so GFM task lists round-trip into real taskList/taskItem nodes) then
// @tiptap/html `generateJSON` against the same node set the editor uses server-side.
import { Marked } from 'marked';
import { generateJSON } from '@tiptap/html';
import { StarterKit } from '@tiptap/starter-kit';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { TableKit } from '@tiptap/extension-table';
import { Image } from '@tiptap/extension-image';
import type { Extensions } from '@tiptap/core';

// A dedicated Marked instance (not the module-global) so we never leak these
// renderer overrides into anything else that happens to `import { marked }`.
const md = new Marked({ gfm: true, breaks: false });

md.use({
  renderer: {
    // Tag task-list items with the data attributes TipTap's TaskItem node expects,
    // while still delegating to the default parser for the item's inner content
    // (which already renders the "- [ ]"/"- [x]" checkbox + paragraph correctly).
    listitem(item) {
      if (!item.task) return false; // fall back to marked's default <li> rendering
      const inner = this.parser.parse(item.tokens);
      return `<li data-type="taskItem" data-checked="${item.checked ? 'true' : 'false'}">${inner}</li>\n`;
    },
    list(token) {
      if (!token.items.length || !token.items.every(item => item.task)) return false; // default <ul>/<ol>
      const body = token.items.map(item => this.listitem(item)).join('');
      return `<ul data-type="taskList">\n${body}</ul>\n`;
    },
  },
});

const extensions: Extensions = [
  StarterKit,
  TaskList,
  TaskItem.configure({ nested: true }),
  TableKit.configure({ table: { resizable: false } }),
  Image,
];

const EMPTY_DOC = { type: 'doc', content: [{ type: 'paragraph' }] };

/** Markdown -> a paragraph-per-block TipTap doc, used only if real parsing fails. */
function plainTextFallback(text: string): Record<string, unknown> {
  const blocks = text.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
  return {
    type: 'doc',
    content: blocks.length
      ? blocks.map(block => ({ type: 'paragraph', content: [{ type: 'text', text: block }] }))
      : [{ type: 'paragraph' }],
  };
}

/**
 * Convert Markdown into a TipTap JSON document. Signature is contract — seed.ts and
 * imports.ts both rely on it staying synchronous and total (never throws).
 */
export function markdownToTipTap(markdown: string): Record<string, unknown> {
  const text = (markdown ?? '').trim();
  if (!text) return EMPTY_DOC;
  try {
    const html = md.parse(text) as string;
    const json = generateJSON(html, extensions) as Record<string, unknown>;
    const content = json.content as unknown[] | undefined;
    if (!content || content.length === 0) return EMPTY_DOC;
    return json;
  } catch {
    return plainTextFallback(text);
  }
}

/** Plain-text projection of markdown (for content_text mirrors). Strips syntax, keeps words. */
export function markdownToPlainText(markdown: string): string {
  let text = markdown ?? '';

  // Fenced code blocks: keep the code, drop the fence + language tag.
  text = text.replace(/```[^\n`]*\n?([\s\S]*?)```/g, (_m, code) => `\n${code}\n`);
  // Inline code.
  text = text.replace(/`([^`\n]+)`/g, '$1');
  // Images: drop the markup, keep the alt text (if any).
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Links: keep the visible text, drop the URL. (Leaves [[wikilinks]] untouched —
  // they have no `(...)` target so this pattern never matches them.)
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // ATX headings.
  text = text.replace(/^#{1,6}\s+/gm, '');
  // Blockquote markers.
  text = text.replace(/^>\s?/gm, '');
  // Horizontal rules.
  text = text.replace(/^\s*([-*_])(\s*\1){2,}\s*$/gm, '');
  // Task list checkboxes, then plain bullets, then ordered list markers.
  text = text.replace(/^(\s*)[-*+]\s+\[[ xX]\]\s+/gm, '$1');
  text = text.replace(/^(\s*)[-*+]\s+/gm, '$1');
  text = text.replace(/^(\s*)\d+[.)]\s+/gm, '$1');
  // Emphasis / strong / strikethrough (order matters: widest delimiter first).
  text = text.replace(/(\*\*\*|___)([^*_]+?)\1/g, '$2');
  text = text.replace(/(\*\*|__)([^*_]+?)\1/g, '$2');
  text = text.replace(/(?<![\w*])\*([^*\n]+?)\*(?!\w)/g, '$1');
  text = text.replace(/(?<![\w_])_([^_\n]+?)_(?!\w)/g, '$1');
  text = text.replace(/~~([^~]+?)~~/g, '$1');
  // Table delimiter rows (---|---|---), then remaining pipe separators.
  text = text.replace(/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/gm, '');
  text = text.replace(/\|/g, ' ');

  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
