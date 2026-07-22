// InsertMenuPopover.tsx — the anchored popover shared by the gutter "+" and the toolbar
// "Insert" button. It wraps the shared InsertMenuList with a search field so both surfaces
// filter and keyboard-navigate exactly like the "/" menu. Positioned with floating-ui so it
// flips/shifts to stay on-screen (including at 390px), and dismisses on Escape / outside click.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { computePosition, offset, flip, shift, autoUpdate, type Placement } from '@floating-ui/dom';
import type { Editor } from '@tiptap/core';
import { getInsertItems, type InsertItem } from './insertables';
import InsertMenuList, { useInsertNavigation } from './InsertMenuList';

interface InsertMenuPopoverProps {
  editor: Editor;
  /** The trigger element to position against. */
  anchor: HTMLElement | null;
  onClose: () => void;
  placement?: Placement;
  /** Runs on the editor just before the chosen item — e.g. move the caret to the "+" block. */
  prepare?: (editor: Editor) => void;
}

export default function InsertMenuPopover({ editor, anchor, onClose, placement = 'bottom-start', prepare }: InsertMenuPopoverProps) {
  const [query, setQuery] = useState('');
  // Stable per query so arrowing through the list does not reset the selection every render.
  const items = useMemo(() => getInsertItems(query), [query]);
  const popRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const listId = useId();

  const choose = useCallback(
    (item: InsertItem) => {
      prepare?.(editor);
      item.run(editor);
      onClose();
    },
    [editor, prepare, onClose],
  );

  const { selected, setSelected, onKeyDown } = useInsertNavigation(items, choose);

  // Position against the trigger, keeping inside the viewport (flip/shift) so it never
  // overflows on a narrow screen.
  useEffect(() => {
    const el = popRef.current;
    if (!anchor || !el) return;
    return autoUpdate(anchor, el, () => {
      computePosition(anchor, el, { placement, middleware: [offset(6), flip(), shift({ padding: 8 })] }).then(({ x, y }) =>
        setPos({ x, y }),
      );
    });
  }, [anchor, placement]);

  // Focus the search field on open so typing filters immediately.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Dismiss on outside pointer / Escape, returning focus to the trigger.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || anchor?.contains(t)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        anchor?.focus();
      }
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchor, onClose]);

  const activeId = items[selected] ? `${listId}-opt-${selected}` : undefined;

  return createPortal(
    <div
      ref={popRef}
      className="folio-insert-pop"
      style={{ position: 'fixed', top: pos?.y ?? 0, left: pos?.x ?? 0, visibility: pos ? 'visible' : 'hidden' }}
    >
      <input
        ref={inputRef}
        className="folio-insert-search"
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={activeId}
        aria-autocomplete="list"
        aria-label="Search blocks to insert"
        placeholder="Search blocks"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') return; // handled by the document listener above
          if (onKeyDown({ event: e.nativeEvent })) e.preventDefault();
        }}
      />
      <InsertMenuList
        items={items}
        selected={selected}
        onHover={setSelected}
        onChoose={choose}
        listId={listId}
        testId="insert-menu"
        itemTestId="insert-menu-item"
      />
      <div className="folio-insert-hint" aria-hidden="true">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> to move
        </span>
        <span>
          <kbd>↵</kbd> to insert
        </span>
        <span>
          <kbd>esc</kbd> to close
        </span>
      </div>
    </div>,
    document.body,
  );
}
