// web-shell — Ctrl/Cmd+K quick switcher. Instant title results, then
// full-text matches below, then a "Create note: <q>" fallback row.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import type { SearchResult, TitleResult } from '../lib/types';
import { relativeTime, parseSnippetHtml, errorMessage } from '../lib/format';
import { useNotebooks } from './NotebooksContext';
import { toast } from './Toast';
import Icon from './Icon';
import Spinner from './Spinner';

export default function QuickSwitcher({
  open,
  onClose,
  currentNotebookId,
}: {
  open: boolean;
  onClose: () => void;
  currentNotebookId?: string;
}) {
  const [query, setQuery] = useState('');
  const [titleResults, setTitleResults] = useState<TitleResult[]>([]);
  const [textResults, setTextResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [creating, setCreating] = useState(false);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const reqIdRef = useRef(0);
  const { notebooks } = useNotebooks();
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setTitleResults([]);
    setTextResults([]);
    setActiveIndex(0);
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (!q) {
      setTitleResults([]);
      setTextResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const myReq = ++reqIdRef.current;
    const t = setTimeout(() => {
      Promise.all([api.searchTitles(q, 8), api.search(q, 8)])
        .then(([titles, search]) => {
          if (reqIdRef.current !== myReq) return;
          setTitleResults(titles.results);
          setTextResults(search.results);
        })
        .catch((e) => {
          if (reqIdRef.current !== myReq) return;
          toast(errorMessage(e, 'Search failed'), 'error');
        })
        .finally(() => {
          if (reqIdRef.current === myReq) setLoading(false);
        });
    }, 120);
    return () => clearTimeout(t);
  }, [query, open]);

  if (!open) return null;

  const titleIds = new Set(titleResults.map((r) => r.id));
  const filteredText = textResults.filter((r) => !titleIds.has(r.note.id));
  const q = query.trim();
  const exactMatch = titleResults.some((r) => r.title.toLowerCase() === q.toLowerCase());
  const showCreate = q.length > 0 && !exactMatch;
  const rowCount = titleResults.length + filteredText.length + (showCreate ? 1 : 0);

  function handleClose() {
    onClose();
  }

  function go(id: string) {
    navigate(`/note/${id}`);
    handleClose();
  }

  async function createFromQuery() {
    const notebookId = currentNotebookId || notebooks[0]?.id;
    if (!notebookId) {
      toast('Create a notebook first', 'error');
      return;
    }
    setCreating(true);
    try {
      const { note } = await api.createNote({ notebookId, title: q });
      toast('Note created', 'ok');
      go(note.id);
    } catch (e) {
      toast(errorMessage(e, 'Could not create note'), 'error');
    } finally {
      setCreating(false);
    }
  }

  function activate(index: number) {
    if (index < titleResults.length) {
      go(titleResults[index].id);
      return;
    }
    const textIndex = index - titleResults.length;
    if (textIndex < filteredText.length) {
      go(filteredText[textIndex].note.id);
      return;
    }
    if (showCreate) createFromQuery();
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      handleClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (rowCount > 0) setActiveIndex((i) => Math.min(i + 1, rowCount - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (rowCount > 0) setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (rowCount > 0) activate(activeIndex);
    }
  }

  return createPortal(
    <div
      className="folio-qs-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div className="folio-qs" role="dialog" aria-modal="true" aria-label="Quick switcher" onKeyDown={onKeyDown}>
        <div className="folio-qs__input-row">
          <Icon name="search" size={16} style={{ color: 'var(--ink-3)', flex: '0 0 auto' }} />
          <input
            ref={inputRef}
            className="folio-qs__input"
            placeholder="Search notes, or type to create one…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search notes"
            autoComplete="off"
            spellCheck={false}
          />
          {loading && <Spinner size={15} />}
        </div>

        <div className="folio-qs__results">
          {!q && (
            <div className="folio-qs__empty">Start typing to find a note by title, or search its contents.</div>
          )}

          {q && titleResults.length > 0 && (
            <>
              {titleResults.map((r, i) => (
                <div
                  key={r.id}
                  className={`folio-qs__row${i === activeIndex ? ' is-active' : ''}`}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => go(r.id)}
                >
                  <span className="folio-qs__row-icon" aria-hidden="true">{r.notebook.emoji}</span>
                  <span className="folio-qs__row-main">
                    <span className="folio-qs__row-title">{r.title || 'Untitled'}</span>
                  </span>
                  <span className="folio-qs__row-meta">
                    <span>{r.notebook.name}</span>
                    <span>·</span>
                    <span>{relativeTime(r.updatedAt)}</span>
                  </span>
                </div>
              ))}
            </>
          )}

          {q && filteredText.length > 0 && (
            <>
              <div className="folio-qs__section-label">Full-text matches</div>
              {filteredText.map((r, j) => {
                const i = titleResults.length + j;
                return (
                  <div
                    key={r.note.id}
                    className={`folio-qs__row${i === activeIndex ? ' is-active' : ''}`}
                    onMouseEnter={() => setActiveIndex(i)}
                    onClick={() => go(r.note.id)}
                  >
                    <span className="folio-qs__row-icon" aria-hidden="true">{r.note.notebook.emoji}</span>
                    <span className="folio-qs__row-main">
                      <span className="folio-qs__row-title">{r.note.title || 'Untitled'}</span>
                      <span className="folio-qs__row-snippet">
                        {parseSnippetHtml(r.snippetHtml).map((seg, si) =>
                          seg.mark ? <mark key={si}>{seg.text}</mark> : <span key={si}>{seg.text}</span>,
                        )}
                      </span>
                    </span>
                    <span className="folio-qs__row-meta">
                      <span>{r.note.notebook.name}</span>
                      <span>·</span>
                      <span>{relativeTime(r.note.updatedAt)}</span>
                    </span>
                  </div>
                );
              })}
            </>
          )}

          {q && !loading && titleResults.length === 0 && filteredText.length === 0 && (
            <div className="folio-qs__empty">No matches for "{q}" yet.</div>
          )}

          {showCreate &&
            (() => {
              const i = titleResults.length + filteredText.length;
              return (
                <div
                  className={`folio-qs__row${i === activeIndex ? ' is-active' : ''}`}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => createFromQuery()}
                >
                  <span className="folio-qs__row-icon" aria-hidden="true">
                    {creating ? <Spinner size={13} /> : <Icon name="plus" size={14} />}
                  </span>
                  <span className="folio-qs__row-main">
                    <span className="folio-qs__row-title">Create note: "{q}"</span>
                  </span>
                </div>
              );
            })()}
        </div>

        <div className="folio-qs__footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
          <span><kbd>Enter</kbd> Open</span>
          <span><kbd>Esc</kbd> Close</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
