// Persistent right-rail table of contents (≥1200px, see notePage.css). Reflects the
// live heading tree; clicking scrolls to and flashes the target heading.
import type { Editor } from '@tiptap/core';
import type { OutlineItem } from './outline';

export default function OutlinePane({ items, editor }: { items: OutlineItem[]; editor: Editor | null }) {
  if (!items.length) return null;

  function go(item: OutlineItem) {
    if (!editor) return;
    const dom =
      editor.view.dom.querySelector<HTMLElement>(`[data-id="${cssEscape(item.id)}"]`) ??
      (editor.view.nodeDOM(item.pos) as HTMLElement | null);
    if (!dom) return;
    dom.scrollIntoView({ behavior: 'smooth', block: 'center' });
    dom.classList.add('folio-flash');
    window.setTimeout(() => dom.classList.remove('folio-flash'), 1200);
  }

  return (
    <nav className="folio-outline" aria-label="Note outline">
      <div className="folio-outline-label">Outline</div>
      <ul>
        {items.map((it, i) => (
          <li key={`${it.id}-${i}`} style={{ paddingLeft: (it.level - 1) * 12 }}>
            <button type="button" onClick={() => go(it)}>
              {it.text}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function cssEscape(s: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
  return s.replace(/["\\]/g, '\\$&');
}
