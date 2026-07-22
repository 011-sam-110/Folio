// The block-level menu rendered inside the existing drag handle (see FolioEditor.tsx's
// <DragHandle>). A plain click opens it (native HTML5 drag only engages after real pointer
// movement past the browser's own drag threshold, so click and drag coexist on the same
// grip without extra plumbing - the pattern tiptap's own drag-handle examples use).
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import ContextMenu, { menuItem, menuDivider, menuLabel, type MenuEntry } from '../../components/ContextMenu';
import { toast } from '../../components/Toast';
import { COLOR_SWATCHES } from './TextColor';

export interface BlockMenuProps {
  editor: Editor;
  noteId?: string;
  target: { node: PMNode; pos: number } | null;
}

// Node types where "Turn into" makes structural sense. Containers like tables, images,
// columnLists and math blocks are left out - there's no sensible text-block conversion.
const TURN_INTO_ELIGIBLE = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'bulletList',
  'orderedList',
  'taskList',
  'codeBlock',
  'callout',
  'details',
]);

interface TurnIntoOption {
  id: string;
  label: string;
  isCurrent: (node: PMNode) => boolean;
  apply: (editor: Editor, from: number, to: number) => void;
}

/** Wraps the block range `[from,to)` in a fresh container node, mirroring how the
 *  Details extension's own `setDetails()` command wraps a selection's block range. */
function wrapRangeInNode(editor: Editor, from: number, to: number, build: (content: unknown[]) => Record<string, unknown>): boolean {
  const { state } = editor;
  const $from = state.doc.resolve(from);
  const $to = state.doc.resolve(to);
  const range = $from.blockRange($to);
  if (!range) return false;
  const slice = state.doc.slice(range.start, range.end);
  const content = (slice.toJSON()?.content ?? []) as unknown[];
  const node = build(content);
  return editor.chain().focus().insertContentAt({ from: range.start, to: range.end }, node as never).run();
}

const TURN_INTO_OPTIONS: TurnIntoOption[] = [
  {
    id: 'paragraph',
    label: 'Text',
    isCurrent: (n) => n.type.name === 'paragraph',
    apply: (e, from, to) => e.chain().focus().setTextSelection({ from, to }).setParagraph().run(),
  },
  {
    id: 'h1',
    label: 'Heading 1',
    isCurrent: (n) => n.type.name === 'heading' && n.attrs.level === 1,
    apply: (e, from, to) => e.chain().focus().setTextSelection({ from, to }).setNode('heading', { level: 1 }).run(),
  },
  {
    id: 'h2',
    label: 'Heading 2',
    isCurrent: (n) => n.type.name === 'heading' && n.attrs.level === 2,
    apply: (e, from, to) => e.chain().focus().setTextSelection({ from, to }).setNode('heading', { level: 2 }).run(),
  },
  {
    id: 'h3',
    label: 'Heading 3',
    isCurrent: (n) => n.type.name === 'heading' && n.attrs.level === 3,
    apply: (e, from, to) => e.chain().focus().setTextSelection({ from, to }).setNode('heading', { level: 3 }).run(),
  },
  {
    id: 'bullet',
    label: 'Bullet list',
    isCurrent: (n) => n.type.name === 'bulletList',
    apply: (e, from, to) => e.chain().focus().setTextSelection({ from, to }).toggleBulletList().run(),
  },
  {
    id: 'ordered',
    label: 'Numbered list',
    isCurrent: (n) => n.type.name === 'orderedList',
    apply: (e, from, to) => e.chain().focus().setTextSelection({ from, to }).toggleOrderedList().run(),
  },
  {
    id: 'todo',
    label: 'To-do list',
    isCurrent: (n) => n.type.name === 'taskList',
    apply: (e, from, to) => e.chain().focus().setTextSelection({ from, to }).toggleTaskList().run(),
  },
  {
    id: 'quote',
    label: 'Quote',
    isCurrent: (n) => n.type.name === 'blockquote',
    apply: (e, from, to) => e.chain().focus().setTextSelection({ from, to }).setBlockquote().run(),
  },
  {
    id: 'callout',
    label: 'Callout',
    isCurrent: (n) => n.type.name === 'callout',
    apply: (e, from, to) => {
      const ok = wrapRangeInNode(e, from, to, (content) => ({
        type: 'callout',
        attrs: { emoji: '💡', tone: 'info' },
        content,
      }));
      if (!ok) toast('Could not convert this block', 'error');
    },
  },
  {
    id: 'code',
    label: 'Code block',
    isCurrent: (n) => n.type.name === 'codeBlock',
    apply: (e, from, to) => e.chain().focus().setTextSelection({ from, to }).toggleCodeBlock().run(),
  },
  {
    id: 'toggle',
    label: 'Toggle',
    isCurrent: (n) => n.type.name === 'details',
    apply: (e, from, to) => e.chain().focus().setTextSelection({ from, to }).setDetails().run(),
  },
];

/** Strips `id` attrs (recursively) from a duplicated node's JSON so the UniqueID
 *  extension mints a fresh one for the copy instead of two blocks sharing one. */
function stripIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripIds);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const next: Record<string, unknown> = { ...obj };
    if (next.attrs && typeof next.attrs === 'object') {
      const attrs = { ...(next.attrs as Record<string, unknown>) };
      if ('id' in attrs) attrs.id = null;
      next.attrs = attrs;
    }
    if (next.content) next.content = stripIds(next.content);
    return next;
  }
  return value;
}

function duplicateBlock(editor: Editor, pos: number, node: PMNode) {
  const json = stripIds(node.toJSON());
  editor.chain().focus().insertContentAt(pos + node.nodeSize, json as never).run();
}

function deleteBlock(editor: Editor, pos: number, node: PMNode) {
  editor.chain().focus().deleteRange({ from: pos, to: pos + node.nodeSize }).run();
}

async function copyBlockLink(node: PMNode, noteId: string | undefined) {
  const blockId = node.attrs.id as string | undefined;
  if (!noteId || !blockId) {
    toast("This block needs a moment to settle before it can be linked. Try again", 'info');
    return;
  }
  const url = `${window.location.origin}/note/${noteId}#block-${blockId}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied', 'ok');
  } catch {
    toast('Could not copy the link', 'error');
  }
}

function buildColorSubmenu(editor: Editor, from: number, to: number): MenuEntry[] {
  return [
    menuLabel('text-label', 'Text color'),
    ...COLOR_SWATCHES.map((s) =>
      menuItem({
        key: `text-${s.id}`,
        label: s.label,
        colorDot: s.text,
        onSelect: () => editor.chain().focus().setTextSelection({ from, to }).setColor(s.text).run(),
      }),
    ),
    menuDivider('color-sep-1'),
    menuLabel('bg-label', 'Background'),
    ...COLOR_SWATCHES.map((s) =>
      menuItem({
        key: `bg-${s.id}`,
        label: s.label,
        colorDot: s.bg,
        onSelect: () => editor.chain().focus().setTextSelection({ from, to }).setBackgroundColor(s.bg).run(),
      }),
    ),
    menuDivider('color-sep-2'),
    menuItem({
      key: 'reset',
      label: 'Reset color',
      icon: 'refresh',
      onSelect: () => editor.chain().focus().setTextSelection({ from, to }).unsetColor().unsetBackgroundColor().run(),
    }),
  ];
}

function buildMenuItems(editor: Editor, node: PMNode, pos: number, noteId: string | undefined): MenuEntry[] {
  const from = pos + 1;
  const to = Math.max(from, pos + node.nodeSize - 1);
  const items: MenuEntry[] = [];

  if (TURN_INTO_ELIGIBLE.has(node.type.name)) {
    const options = TURN_INTO_OPTIONS.filter((opt) => !opt.isCurrent(node));
    items.push(
      menuItem({
        key: 'turn-into',
        label: 'Turn into',
        icon: 'layers',
        submenu: options.map((opt) => menuItem({ key: `turn-${opt.id}`, label: opt.label, onSelect: () => opt.apply(editor, from, to) })),
      }),
    );
  }

  items.push(menuItem({ key: 'color', label: 'Color', icon: 'palette', submenu: buildColorSubmenu(editor, from, to) }));
  items.push(menuDivider('d1'));
  items.push(menuItem({ key: 'duplicate', label: 'Duplicate', icon: 'copy', onSelect: () => duplicateBlock(editor, pos, node) }));
  items.push(
    menuItem({ key: 'copy-link', label: 'Copy link to block', icon: 'link', onSelect: () => void copyBlockLink(node, noteId) }),
  );
  items.push(menuDivider('d2'));
  items.push(menuItem({ key: 'delete', label: 'Delete', icon: 'trash', danger: true, onSelect: () => deleteBlock(editor, pos, node) }));

  return items;
}

export default function BlockMenu({ editor, noteId, target }: BlockMenuProps) {
  if (!target) {
    return (
      <span className="folio-drag-handle" aria-hidden="true">
        ⠿
      </span>
    );
  }

  const items = buildMenuItems(editor, target.node, target.pos, noteId);

  return <ContextMenu trigger={<span aria-hidden="true">⠿</span>} triggerClassName="folio-drag-handle" ariaLabel="Block menu" items={items} />;
}
