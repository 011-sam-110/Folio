// Floating popup for the `[[` wikilink Suggestion plugin: title matches plus a
// "Create note: X" row when nothing matches exactly.
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import type { SuggestionListHandle } from './suggestionRenderer';
import type { WikilinkSuggestionItem } from './WikilinkExtension';
import { relativeTime } from '../../lib/format';

interface WikilinkListProps {
  items: WikilinkSuggestionItem[];
  command: (item: WikilinkSuggestionItem) => void;
}

const WikilinkList = forwardRef<SuggestionListHandle, WikilinkListProps>(({ items, command }, ref) => {
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
    return <div className="folio-suggestion-menu folio-suggestion-empty">Type to search notes…</div>;
  }

  return (
    <div className="folio-suggestion-menu folio-wikilink-menu" role="listbox">
      {items.map((item, idx) => (
        <button
          key={item.__create ? '__create__' : item.id}
          type="button"
          role="option"
          aria-selected={idx === selected}
          className={`folio-suggestion-item${idx === selected ? ' active' : ''}`}
          onMouseEnter={() => setSelected(idx)}
          onClick={() => command(item)}
        >
          <span className="folio-suggestion-icon">{item.__create ? '➕' : '📄'}</span>
          <span className="folio-suggestion-text">
            <span className="folio-suggestion-title">{item.__create ? `Create note: "${item.title}"` : item.title}</span>
            {!item.__create && (
              <span className="folio-suggestion-desc">
                {item.notebook ? `${item.notebook.emoji} ${item.notebook.name}` : ''}
                {item.updatedAt ? ` · ${relativeTime(item.updatedAt)}` : ''}
              </span>
            )}
          </span>
        </button>
      ))}
    </div>
  );
});

WikilinkList.displayName = 'WikilinkList';
export default WikilinkList;
