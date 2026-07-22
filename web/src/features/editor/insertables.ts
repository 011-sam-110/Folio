// insertables.ts — the single catalog behind Folio's Insert experience.
//
// Three surfaces share this one registry:
//   - the "/" slash menu            (SlashCommand -> SlashMenu)
//   - the gutter "+" button         (FolioEditor  -> InsertMenuPopover)
//   - the toolbar "Insert" button   (NotePage     -> InsertMenuPopover)
// All of them render InsertMenuList over these items, so adding an entry here lights
// it up in all three places at once with identical keyboard nav and ARIA.
//
// -- Registering a new insertable ---------------------------------------------
// Append ONE InsertItem to INSERT_ITEMS. Nothing else needs to change:
//
//   {
//     id: 'chemistry',
//     title: 'Chemical formula',
//     description: 'Inline SMILES or formula',
//     icon: 'flask',                 // an Icon name (preferred), else a short glyph like the sum sign
//     section: 'Notation',           // Basic | Lists | Notation | Media | Layout | Advanced
//     keywords: ['smiles', 'molecule'],
//     run: (editor, range) => at(editor, range).insertContent('...').run(),
//   }
//
// `run` MUST handle BOTH call shapes:
//   - range === undefined  -> insert at the current caret   (the "+"/toolbar path)
//   - range === {from,to}  -> delete that range first        (the "/" query text)
// Build every command off the shared `at(editor, range)` helper below and both are
// handled for you. Prefer an Icon name for `icon` so the row matches the design
// system; a literal glyph is the fallback when no vector icon fits.
import type { Editor } from '@tiptap/core';
import { pickAndInsertImage } from './imageUpload';
import { buildColumnsContent } from './Columns';
import { toast } from '../../components/Toast';
import { chemInsertable } from './nodes/chem/chemInsertable';
import { model3dInsertable } from './nodes/model3d/model3dInsertable';
import { sketchInsertables } from './nodes/sketch';

export type InsertSection = 'Basic' | 'Lists' | 'Notation' | 'Media' | 'Layout' | 'Advanced';

/** The order sections are rendered in. Sections with no matching items are skipped. */
export const INSERT_SECTIONS: InsertSection[] = ['Basic', 'Lists', 'Notation', 'Media', 'Layout', 'Advanced'];

export interface InsertItem {
  id: string;
  title: string;
  description: string;
  /** An Icon name (rendered as a vector) when it matches one, otherwise a short text glyph. */
  icon: string;
  section: InsertSection;
  keywords?: string[];
  /** Insert at the caret when `range` is omitted; delete `range` (the "/" query) first when given. */
  run: (editor: Editor, range?: { from: number; to: number }) => void;
}

type Range = { from: number; to: number };

/** Shared chain head for every item: focus the editor, and when a "/"-query range is
 *  supplied, delete it first so the inserted node replaces the typed command. */
function at(editor: Editor, range?: Range) {
  const chain = editor.chain().focus();
  return range ? chain.deleteRange(range) : chain;
}

export const INSERT_ITEMS: InsertItem[] = [
  // -- Basic ------------------------------------------------------------------
  {
    id: 'text',
    title: 'Text',
    description: 'Plain paragraph',
    icon: 'type',
    section: 'Basic',
    keywords: ['paragraph', 'body'],
    run: (e, r) => at(e, r).setParagraph().run(),
  },
  {
    id: 'h1',
    title: 'Heading 1',
    description: 'Big section heading',
    icon: 'H1',
    section: 'Basic',
    keywords: ['title'],
    run: (e, r) => at(e, r).setNode('heading', { level: 1 }).run(),
  },
  {
    id: 'h2',
    title: 'Heading 2',
    description: 'Medium section heading',
    icon: 'H2',
    section: 'Basic',
    run: (e, r) => at(e, r).setNode('heading', { level: 2 }).run(),
  },
  {
    id: 'h3',
    title: 'Heading 3',
    description: 'Small section heading',
    icon: 'H3',
    section: 'Basic',
    run: (e, r) => at(e, r).setNode('heading', { level: 3 }).run(),
  },
  {
    id: 'quote',
    title: 'Quote',
    description: 'Capture a citation',
    icon: '❝',
    section: 'Basic',
    keywords: ['blockquote', 'citation'],
    run: (e, r) => at(e, r).setBlockquote().run(),
  },
  {
    id: 'divider',
    title: 'Divider',
    description: 'Visually divide sections',
    icon: '―',
    section: 'Basic',
    keywords: ['hr', 'line', 'rule', 'separator'],
    run: (e, r) => at(e, r).setHorizontalRule().run(),
  },

  // -- Lists ------------------------------------------------------------------
  {
    id: 'bullet',
    title: 'Bullet list',
    description: 'Simple unordered list',
    icon: '•',
    section: 'Lists',
    keywords: ['ul', 'unordered'],
    run: (e, r) => at(e, r).toggleBulletList().run(),
  },
  {
    id: 'ordered',
    title: 'Numbered list',
    description: 'List with numbering',
    icon: '1.',
    section: 'Lists',
    keywords: ['ol', 'ordered'],
    run: (e, r) => at(e, r).toggleOrderedList().run(),
  },
  {
    id: 'todo',
    title: 'To-do list',
    description: 'Track tasks with checkboxes',
    icon: 'check',
    section: 'Lists',
    keywords: ['task', 'checkbox'],
    run: (e, r) => at(e, r).toggleTaskList().run(),
  },
  {
    id: 'toggle',
    title: 'Toggle',
    description: 'Collapsible content block',
    icon: 'chevron-right',
    section: 'Lists',
    keywords: ['details', 'collapse', 'accordion'],
    run: (e, r) => at(e, r).setDetails().run(),
  },

  // -- Notation ---------------------------------------------------------------
  // Extension point: Chemistry, 3D and Sketch items land here alongside math.
  {
    id: 'inline-math',
    title: 'Inline math',
    description: 'LaTeX inside a line of text',
    icon: 'x²',
    section: 'Notation',
    keywords: ['latex', 'equation', 'katex', 'formula', 'inline', 'math'],
    run: (e, r) => at(e, r).insertInlineMath({ latex: 'x^2' }).run(),
  },
  {
    id: 'math-block',
    title: 'Math block',
    description: 'Standalone LaTeX equation',
    icon: '∑',
    section: 'Notation',
    keywords: ['latex', 'equation', 'katex', 'formula', 'block', 'display'],
    run: (e, r) => at(e, r).insertBlockMath({ latex: 'a^2 + b^2 = c^2' }).run(),
  },
  chemInsertable,
  model3dInsertable,
  ...sketchInsertables,

  // -- Media ------------------------------------------------------------------
  {
    id: 'image',
    title: 'Image',
    description: 'Upload and embed an image',
    icon: 'image',
    section: 'Media',
    keywords: ['picture', 'photo', 'upload'],
    run: (e, r) => {
      at(e, r).run();
      pickAndInsertImage(e);
    },
  },
  {
    id: 'table',
    title: 'Table',
    description: '3x3 table with a header row',
    icon: '▦',
    section: 'Media',
    keywords: ['grid', 'rows', 'columns'],
    run: (e, r) => at(e, r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    id: 'callout',
    title: 'Callout',
    description: 'Highlighted block for notes',
    icon: 'info',
    section: 'Media',
    keywords: ['info', 'box', 'note', 'warning', 'tip'],
    run: (e, r) =>
      at(e, r)
        .insertContent({ type: 'callout', attrs: { emoji: '💡', tone: 'info' }, content: [{ type: 'paragraph' }] })
        .run(),
  },

  // -- Layout -----------------------------------------------------------------
  {
    id: 'columns-2',
    title: '2 columns',
    description: 'Side-by-side layout',
    icon: '❘❘',
    section: 'Layout',
    keywords: ['column', 'columns', 'layout', 'side by side'],
    run: (e, r) => at(e, r).insertContent(buildColumnsContent(2)).run(),
  },
  {
    id: 'columns-3',
    title: '3 columns',
    description: 'Three-way side-by-side layout',
    icon: '❘❘❘',
    section: 'Layout',
    keywords: ['column', 'columns', 'layout', 'side by side'],
    run: (e, r) => at(e, r).insertContent(buildColumnsContent(3)).run(),
  },

  // -- Advanced ---------------------------------------------------------------
  {
    id: 'code',
    title: 'Code block',
    description: 'Syntax-highlighted code',
    icon: '{ }',
    section: 'Advanced',
    keywords: ['snippet', 'pre'],
    run: (e, r) => at(e, r).toggleCodeBlock().run(),
  },
  {
    id: 'toc',
    title: 'Table of contents',
    description: 'Jump to the outline panel',
    icon: 'menu',
    section: 'Advanced',
    keywords: ['outline', 'headings', 'contents'],
    run: (e, r) => {
      at(e, r).run();
      // The outline panel is a DOM affordance owned by NotePage, so this steers to it
      // (rather than inserting a node). It only mounts on wide viewports.
      const el = document.querySelector('.folio-outline');
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('folio-flash');
        window.setTimeout(() => el.classList.remove('folio-flash'), 1200);
      } else {
        toast('The outline panel needs a wider window (min 1200px)', 'info');
      }
    },
  },
];

/** Subsequence match: every char of `query` appears in order within `target`. */
function fuzzy(query: string, target: string): boolean {
  let qi = 0;
  for (let i = 0; i < target.length && qi < query.length; i++) {
    if (target[i] === query[qi]) qi++;
  }
  return qi === query.length;
}

/** Filter the catalog for a menu query (case-insensitive, title + description + keywords). */
export function getInsertItems(query: string): InsertItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return INSERT_ITEMS;
  return INSERT_ITEMS.filter((item) => {
    const hay = [item.title, item.description, ...(item.keywords ?? [])].join(' ').toLowerCase();
    return hay.includes(q) || fuzzy(q, item.title.toLowerCase());
  });
}
