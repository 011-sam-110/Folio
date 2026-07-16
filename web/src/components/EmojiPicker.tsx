// web-shell — small curated emoji grid, used for notebook icons. Click the
// trigger (renders `value`) to open; click an emoji to select and close.
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useFloatingPanel } from './useFloatingPanel';

export const CURATED_NOTEBOOK_EMOJI = [
  '📓', '📔', '📒', '📕', '📗', '📘', '📙', '📚',
  '📝', '✏️', '🧮', '💻', '🖥️', '⚙️', '🔧', '🧪',
  '🔬', '🌐', '🗄️', '🧩', '✨', '🎯', '📊', '📈',
  '🧠', '🔍', '🐛', '☕', '📐', '📎', '🗂️', '🎓',
  '🏫', '📅', '⏰', '🔥', '🚀', '🌟', '💡', '🍎',
];

export default function EmojiPicker({
  value,
  onSelect,
  label = 'Change emoji',
  size = 16,
}: {
  value: string;
  onSelect: (emoji: string) => void;
  label?: string;
  size?: number;
}) {
  const [open, setOpen] = useState(false);
  const { refEl, panelEl, pos } = useFloatingPanel(open, () => setOpen(false), { placement: 'bottom-start' });

  return (
    <>
      <button
        ref={refEl}
        type="button"
        className="folio-emoji-trigger"
        style={{ fontSize: size }}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        {value}
      </button>
      {open &&
        createPortal(
          <div
            ref={panelEl}
            className="folio-emoji-panel"
            role="dialog"
            aria-label="Choose an emoji"
            style={{ position: 'fixed', top: pos.y, left: pos.x }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {CURATED_NOTEBOOK_EMOJI.map((e) => (
              <button
                key={e}
                type="button"
                aria-label={e}
                aria-current={e === value}
                onClick={() => {
                  onSelect(e);
                  setOpen(false);
                }}
              >
                {e}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
