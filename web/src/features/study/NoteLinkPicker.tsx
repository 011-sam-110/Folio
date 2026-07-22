// Small inline "link a note" combobox for the flashcard composer - search-as-you-type
// against api.searchTitles (same endpoint the quick switcher and wikilink suggestion use),
// picked note renders as a removable chip. Not a modal: floats under the trigger input via
// the shared useFloatingPanel hook so it behaves like the rest of the app's popovers.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../lib/api';
import type { TitleResult } from '../../lib/types';
import { useFloatingPanel } from '../../components/useFloatingPanel';
import Icon from '../../components/Icon';
import Spinner from '../../components/Spinner';
import './StudyPage.css';

export default function NoteLinkPicker({
  value,
  onChange,
}: {
  value: TitleResult | null;
  onChange: (note: TitleResult | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<TitleResult[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const reqIdRef = useRef(0);
  const { refEl, panelEl, pos } = useFloatingPanel<HTMLDivElement>(open, () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (!q) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const myReq = ++reqIdRef.current;
    const t = setTimeout(() => {
      api
        .searchTitles(q, 8)
        .then((res) => {
          if (reqIdRef.current === myReq) setResults(res.results);
        })
        .catch(() => {
          if (reqIdRef.current === myReq) setResults([]);
        })
        .finally(() => {
          if (reqIdRef.current === myReq) setLoading(false);
        });
    }, 150);
    return () => clearTimeout(t);
  }, [query, open]);

  if (value) {
    return (
      <span className="sy-note-picker__chip">
        <Icon name="file-text" size={12} />
        {value.title}
        <button
          type="button"
          className="sy-note-picker__clear"
          aria-label={`Remove link to ${value.title}`}
          onClick={() => onChange(null)}
        >
          <Icon name="x" size={11} />
        </button>
      </span>
    );
  }

  return (
    <div className="sy-note-picker" ref={refEl}>
      <input
        ref={inputRef}
        className="sy-note-picker__input"
        type="text"
        aria-label="Link a note"
        placeholder="Link a note (optional)…"
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            setOpen(false);
          }
        }}
      />
      {open &&
        query.trim() &&
        createPortal(
          <div ref={panelEl} className="sy-note-picker__panel" style={{ position: 'fixed', top: pos.y, left: pos.x }}>
            {loading ? (
              <div className="sy-note-picker__status">
                <Spinner size={13} /> Searching…
              </div>
            ) : results.length === 0 ? (
              <div className="sy-note-picker__status">No matching notes</div>
            ) : (
              results.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className="sy-note-picker__option"
                  onClick={() => {
                    onChange(r);
                    setOpen(false);
                    setQuery('');
                  }}
                >
                  <span className="sy-note-picker__option-title">{r.title}</span>
                  <span className="sy-note-picker__option-nb">
                    {r.notebook.emoji} {r.notebook.name}
                  </span>
                </button>
              ))
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
