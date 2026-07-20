// Floating command palette rendered by the '/' Suggestion plugin (see SlashCommand.ts).
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import type { SlashItem, SlashSection } from './SlashItems';
import type { SuggestionListHandle } from './suggestionRenderer';

interface SlashMenuProps {
  items: SlashItem[];
  command: (item: SlashItem) => void;
}

const SECTION_ORDER: SlashSection[] = ['Basic', 'Lists', 'Media', 'Layout', 'Advanced'];

const SlashMenu = forwardRef<SuggestionListHandle, SlashMenuProps>(({ items, command }, ref) => {
  const [selected, setSelected] = useState(0);

  useEffect(() => setSelected(0), [items]);

  useImperativeHandle(
    ref,
    () => ({
      onKeyDown: ({ event }) => {
        if (!items.length) return false;
        if (event.key === 'ArrowDown') {
          setSelected((i) => (i + 1) % items.length);
          return true;
        }
        if (event.key === 'ArrowUp') {
          setSelected((i) => (i - 1 + items.length) % items.length);
          return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          const item = items[selected];
          if (item) command(item);
          return true;
        }
        return false;
      },
    }),
    [items, selected, command],
  );

  if (!items.length) {
    return <div className="folio-suggestion-menu folio-suggestion-empty">No matching commands</div>;
  }

  let flatIndex = -1;
  const sections = SECTION_ORDER.filter((s) => items.some((i) => i.section === s));

  return (
    <div className="folio-suggestion-menu folio-slash-menu" role="listbox" data-testid="slash-menu">
      {sections.map((section) => (
        <div key={section} className="folio-suggestion-section">
          <div className="folio-suggestion-section-label">{section}</div>
          {items
            .filter((i) => i.section === section)
            .map((item) => {
              flatIndex += 1;
              const idx = flatIndex;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={idx === selected}
                  className={`folio-suggestion-item${idx === selected ? ' active' : ''}`}
                  data-testid="slash-menu-item"
                  onMouseEnter={() => setSelected(idx)}
                  onClick={() => command(item)}
                >
                  <span className="folio-suggestion-icon">{item.icon}</span>
                  <span className="folio-suggestion-text">
                    <span className="folio-suggestion-title">{item.title}</span>
                    <span className="folio-suggestion-desc">{item.description}</span>
                  </span>
                </button>
              );
            })}
        </div>
      ))}
    </div>
  );
});

SlashMenu.displayName = 'SlashMenu';
export default SlashMenu;
