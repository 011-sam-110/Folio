// The '/' command palette's item catalog: what each entry inserts, and how it's filtered.
import type { Editor } from '@tiptap/core';
import { pickAndInsertImage } from './imageUpload';
import { buildColumnsContent } from './Columns';

export interface SlashCommandContext {
  onTableOfContents?: () => void;
}

export type SlashSection = 'Basic' | 'Lists' | 'Media' | 'Layout' | 'Advanced';

export interface SlashItem {
  id: string;
  title: string;
  description: string;
  icon: string;
  section: SlashSection;
  keywords?: string[];
  run: (editor: Editor, range: { from: number; to: number }, ctx: SlashCommandContext) => void;
}

function del(editor: Editor, range: { from: number; to: number }) {
  return editor.chain().focus().deleteRange(range);
}

export const SLASH_ITEMS: SlashItem[] = [
  {
    id: 'text',
    title: 'Text',
    description: 'Plain paragraph',
    icon: '📝',
    section: 'Basic',
    keywords: ['paragraph'],
    run: (e, r) => del(e, r).setParagraph().run(),
  },
  {
    id: 'h1',
    title: 'Heading 1',
    description: 'Big section heading',
    icon: 'H1',
    section: 'Basic',
    run: (e, r) => del(e, r).setNode('heading', { level: 1 }).run(),
  },
  {
    id: 'h2',
    title: 'Heading 2',
    description: 'Medium section heading',
    icon: 'H2',
    section: 'Basic',
    run: (e, r) => del(e, r).setNode('heading', { level: 2 }).run(),
  },
  {
    id: 'h3',
    title: 'Heading 3',
    description: 'Small section heading',
    icon: 'H3',
    section: 'Basic',
    run: (e, r) => del(e, r).setNode('heading', { level: 3 }).run(),
  },
  {
    id: 'quote',
    title: 'Quote',
    description: 'Capture a citation',
    icon: '❝',
    section: 'Basic',
    run: (e, r) => del(e, r).setBlockquote().run(),
  },
  {
    id: 'divider',
    title: 'Divider',
    description: 'Visually divide sections',
    icon: '—',
    section: 'Basic',
    keywords: ['hr', 'line', 'rule'],
    run: (e, r) => del(e, r).setHorizontalRule().run(),
  },
  {
    id: 'bullet',
    title: 'Bullet list',
    description: 'Simple unordered list',
    icon: '•',
    section: 'Lists',
    keywords: ['ul', 'unordered'],
    run: (e, r) => del(e, r).toggleBulletList().run(),
  },
  {
    id: 'ordered',
    title: 'Numbered list',
    description: 'List with numbering',
    icon: '1.',
    section: 'Lists',
    keywords: ['ol', 'ordered'],
    run: (e, r) => del(e, r).toggleOrderedList().run(),
  },
  {
    id: 'todo',
    title: 'To-do list',
    description: 'Track tasks with checkboxes',
    icon: '☑',
    section: 'Lists',
    keywords: ['task', 'checkbox'],
    run: (e, r) => del(e, r).toggleTaskList().run(),
  },
  {
    id: 'toggle',
    title: 'Toggle',
    description: 'Collapsible content block',
    icon: '▸',
    section: 'Lists',
    keywords: ['details', 'collapse', 'accordion'],
    run: (e, r) => del(e, r).setDetails().run(),
  },
  {
    id: 'image',
    title: 'Image',
    description: 'Upload and embed an image',
    icon: '🖼',
    section: 'Media',
    keywords: ['picture', 'photo', 'upload'],
    run: (e, r) => {
      del(e, r).run();
      pickAndInsertImage(e);
    },
  },
  {
    id: 'table',
    title: 'Table',
    description: '3×3 table with a header row',
    icon: '▦',
    section: 'Media',
    run: (e, r) => del(e, r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    id: 'columns-2',
    title: '2 columns',
    description: 'Side-by-side layout',
    icon: '❘❘',
    section: 'Layout',
    keywords: ['column', 'columns', 'layout', 'side by side'],
    run: (e, r) => del(e, r).insertContent(buildColumnsContent(2)).run(),
  },
  {
    id: 'columns-3',
    title: '3 columns',
    description: 'Three-way side-by-side layout',
    icon: '❘❘❘',
    section: 'Layout',
    keywords: ['column', 'columns', 'layout', 'side by side'],
    run: (e, r) => del(e, r).insertContent(buildColumnsContent(3)).run(),
  },
  {
    id: 'callout',
    title: 'Callout',
    description: 'Highlighted block for notes',
    icon: '💡',
    section: 'Media',
    keywords: ['info', 'box', 'note', 'warning', 'tip'],
    run: (e, r) =>
      del(e, r)
        .insertContent({ type: 'callout', attrs: { emoji: '💡', tone: 'info' }, content: [{ type: 'paragraph' }] })
        .run(),
  },
  {
    id: 'code',
    title: 'Code block',
    description: 'Syntax-highlighted code',
    icon: '{ }',
    section: 'Advanced',
    keywords: ['snippet'],
    run: (e, r) => del(e, r).toggleCodeBlock().run(),
  },
  {
    id: 'math-block',
    title: 'Math block',
    description: 'Block LaTeX equation',
    icon: '∑',
    section: 'Advanced',
    keywords: ['latex', 'equation', 'katex', 'formula'],
    run: (e, r) => {
      del(e, r).run();
      e.chain().focus().insertBlockMath({ latex: 'a^2 + b^2 = c^2' }).run();
    },
  },
  {
    id: 'toc',
    title: 'Table of contents',
    description: 'Jump to the outline panel',
    icon: '☰',
    section: 'Advanced',
    keywords: ['outline', 'headings'],
    run: (e, r, ctx) => {
      del(e, r).run();
      ctx.onTableOfContents?.();
    },
  },
];

function fuzzy(query: string, target: string): boolean {
  let qi = 0;
  for (let i = 0; i < target.length && qi < query.length; i++) {
    if (target[i] === query[qi]) qi++;
  }
  return qi === query.length;
}

export function getSlashItems(query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return SLASH_ITEMS;
  return SLASH_ITEMS.filter((item) => {
    const hay = [item.title, item.description, ...(item.keywords ?? [])].join(' ').toLowerCase();
    return hay.includes(q) || fuzzy(q, item.title.toLowerCase());
  });
}
