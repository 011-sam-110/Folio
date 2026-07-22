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

/** Resolve a wikilink target title to a note id (or null if none). Callers that have a DB
 *  pass a real resolver; the default leaves every wikilink unresolved (a real node with
 *  noteId: null, which the editor styles as 'missing'). */
export type NoteIdResolver = (title: string) => string | null;
const NO_RESOLVE: NoteIdResolver = () => null;

interface JsonNode {
  type?: string;
  text?: string;
  marks?: Array<{ type: string }>;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
}

// [[Title]] | [[Title|Alias]] | $$display$$ | $inline$  (checked in this order per match).
const INLINE_RE = /\[\[([^[\]|]+)(?:\|([^[\]]*))?\]\]|\$\$([^$]+?)\$\$|\$([^$\n]+?)\$/g;
const BLOCK_MATH_RE = /^\$\$([\s\S]+?)\$\$$/;

/** Split one text node into a sequence of text / inlineMath / wikilink nodes. */
function tokenizeText(node: JsonNode, resolve: NoteIdResolver): JsonNode[] {
  const text = node.text ?? '';
  // Never rewrite inside inline code.
  if (node.marks?.some(m => m.type === 'code')) return [node];
  if (!/\[\[|\$/.test(text)) return [node];

  const out: JsonNode[] = [];
  const marks = node.marks;
  let last = 0;
  INLINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  const pushText = (s: string) => {
    if (!s) return;
    out.push(marks ? { type: 'text', text: s, marks } : { type: 'text', text: s });
  };
  while ((m = INLINE_RE.exec(text))) {
    pushText(text.slice(last, m.index));
    if (m[1] !== undefined) {
      const title = m[1].trim();
      const alias = m[2]?.trim() || null;
      out.push({ type: 'wikilink', attrs: { noteId: resolve(title), title, alias } });
    } else {
      const latex = (m[3] ?? m[4] ?? '').trim();
      out.push({ type: 'inlineMath', attrs: { latex } });
    }
    last = INLINE_RE.lastIndex;
  }
  pushText(text.slice(last));
  return out.length ? out : [node];
}

/** Recursively rewrite wikilinks/math in a node, returning replacement node(s). */
function transformNode(node: JsonNode, resolve: NoteIdResolver): JsonNode[] {
  if (node.type === 'text') return tokenizeText(node, resolve);
  // Don't touch the innards of code blocks.
  if (node.type === 'codeBlock') return [node];

  // A paragraph that is exactly $$...$$ becomes a block-math node.
  if (node.type === 'paragraph' && node.content?.length === 1 && node.content[0].type === 'text') {
    const bm = BLOCK_MATH_RE.exec((node.content[0].text ?? '').trim());
    if (bm) return [{ type: 'blockMath', attrs: { latex: bm[1].trim() } }];
  }

  if (Array.isArray(node.content)) {
    return [{ ...node, content: node.content.flatMap(c => transformNode(c, resolve)) }];
  }
  return [node];
}

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
 * Convert Markdown into a TipTap JSON document. Signature is contract - seed.ts and
 * imports.ts both rely on it staying synchronous and total (never throws). `resolve`
 * maps a [[wikilink]] title to a note id so imported/AI content renders as real,
 * clickable wikilinks (and $...$ / $$...$$ as real KaTeX math nodes).
 */
export function markdownToTipTap(markdown: string, resolve: NoteIdResolver = NO_RESOLVE): Record<string, unknown> {
  const text = (markdown ?? '').trim();
  if (!text) return EMPTY_DOC;
  try {
    const html = md.parse(text) as string;
    const json = generateJSON(html, extensions) as Record<string, unknown>;
    const content = json.content as unknown[] | undefined;
    if (!content || content.length === 0) return EMPTY_DOC;
    const doc = json as unknown as JsonNode;
    const transformed = Array.isArray(doc.content) ? doc.content.flatMap(c => transformNode(c, resolve)) : doc.content;
    return { ...json, content: transformed } as Record<string, unknown>;
  } catch {
    return plainTextFallback(text);
  }
}

/** Normalise a heading/title for equality checks (case, whitespace, trailing punctuation). */
function normalizeHeading(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.:;!?]+$/, '');
}

/** Drop a leading H1 that just repeats the note's title, so imported/seeded notes don't show
 *  the title twice (once in the title field, once as the first body heading). */
export function stripLeadingTitleHeading(markdown: string, title: string): string {
  const target = normalizeHeading(title);
  if (!target) return markdown;
  // Only touch a leading level-1 heading (allowing blank lines before it).
  const m = markdown.match(/^(\s*)#\s+(.+?)\s*(\r?\n|$)/);
  if (m && normalizeHeading(m[2]) === target) {
    return markdown.slice(m[0].length).replace(/^\s*\n/, '');
  }
  return markdown;
}

/** Plain-text projection of markdown (for content_text mirrors). Strips syntax, keeps words. */
export function markdownToPlainText(markdown: string): string {
  let text = markdown ?? '';

  // Collapse aliased wikilinks to their canonical [[Title]] form BEFORE any table-pipe
  // handling below turns the `|` into a space (which would corrupt [[Title|Alias]] into an
  // unresolvable [[Title Alias]]). This matches the editor's own renderText serialization.
  text = text.replace(/\[\[([^[\]|]+)\|[^[\]]*\]\]/g, '[[$1]]');

  // Fenced code blocks: keep the code, drop the fence + language tag.
  text = text.replace(/```[^\n`]*\n?([\s\S]*?)```/g, (_m, code) => `\n${code}\n`);
  // Inline code.
  text = text.replace(/`([^`\n]+)`/g, '$1');
  // Images: drop the markup, keep the alt text (if any).
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Links: keep the visible text, drop the URL. (Leaves [[wikilinks]] untouched -
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
