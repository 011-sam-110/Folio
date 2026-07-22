// The "/" command palette popup. A thin wrapper over the shared InsertMenuList so the
// slash menu, the gutter "+" and the toolbar Insert button all look and keyboard-navigate
// the same. The @tiptap/suggestion plugin forwards key events through the ref handle.
import { forwardRef, useId, useImperativeHandle } from 'react';
import type { InsertItem } from './insertables';
import type { SuggestionListHandle } from './suggestionRenderer';
import InsertMenuList, { useInsertNavigation } from './InsertMenuList';

interface SlashMenuProps {
  items: InsertItem[];
  command: (item: InsertItem) => void;
}

const SlashMenu = forwardRef<SuggestionListHandle, SlashMenuProps>(({ items, command }, ref) => {
  const listId = useId();
  const { selected, setSelected, onKeyDown } = useInsertNavigation(items, command);
  useImperativeHandle(ref, () => ({ onKeyDown }), [onKeyDown]);

  return (
    <div className="folio-insert-surface">
      <InsertMenuList
        items={items}
        selected={selected}
        onHover={setSelected}
        onChoose={command}
        listId={listId}
        testId="slash-menu"
        itemTestId="slash-menu-item"
        emptyLabel="No matching commands"
      />
    </div>
  );
});

SlashMenu.displayName = 'SlashMenu';
export default SlashMenu;
