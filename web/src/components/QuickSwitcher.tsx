// web-shell — Ctrl/Cmd+K quick switcher. Instant title results, then
// full-text matches below, then a "Create note: <q>" fallback row.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import type { SearchResult, TitleResult } from '../lib/types';
import { relativeTime, parseSnippetHtml, errorMessage } from '../lib/format';
import { resolveFilingNotebook } from '../lib/notebookContext';
import { useNotebooks } from './NotebooksContext';
import { toast } from './Toast';
import Icon from './Icon';
import Spinner from './Spinner';
import { useDialogFocus } from './useDialogFocus';

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
  const panelRef = useRef<HTMLDivElement | null>(null);
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

  // Makes the role="dialog" claim true: traps Tab, closes on Escape from anywhere,
  // and restores focus to the trigger. `false` because this panel focuses its own
  // search input (handleClose is hoisted, so referencing it here is fine).
  useDialogFocus(open, panelRef, handleClose, { takeInitialFocus: false });

  if (!open) return null;

  const titleIds = new Set(titleResults.map((r) => r.id));
  const filteredText = textResults.filter((r) => !titleIds.has(r.note.id));
  const q = query.trim();
  const exactMatch = titleResults.some((r) => r.title.toLowerCase() === q.toLowerCase());
  const showCreate = q.length > 0 && !exactMatch;
  // Always-available escape hatch to the full /search page — its paginated,
  // operator-aware results (tag:/notebook:/"phrase"/-exclude) go well beyond
  // what this popup's capped title+full-text lists can show.
  const showSearchAll = q.length > 0;
  const rowCount = titleResults.length + filteredText.length + (showCreate ? 1 : 0) + (showSearchAll ? 1 : 0);

  function handleClose() {
    onClose();
  }

  function go(id: string) {
    navigate(`/note/${id}`);
    handleClose();
  }

  async function createFromQuery() {
    // File into the current context (open note's notebook / last-used), not notebooks[0].
    const notebookId = resolveFilingNotebook(currentNotebookId, notebooks);
    if (!notebookId) {
      toast('Create a notebook first', 'error');
      return;
    }
    setCreating(true);
    try {
      const { note } = await api.createNote({ notebookId, title: q });
      const nb = notebooks.find((n) => n.id === notebookId);
      toast(nb ? `Note created in ${nb.emoji} ${nb.name}` : 'Note created', 'ok');
      go(note.id);
    } catch (e) {
      toast(errorMessage(e, 'Could not create note'), 'error');
    } finally {
      setCreating(false);
    }
  }

  function goSearchAll() {
    navigate(`/search?q=${encodeURIComponent(q)}`);
    handleClose();
  }

  function activate(index: number) {
    if (index < titleResults.length) {
      go(titleResults[index].id);
      return;
    }
    let idx = index - titleResults.length;
    if (idx < filteredText.length) {
      go(filteredText[idx].note.id);
      return;
    }
    idx -= filteredText.length;
    if (showCreate) {
      if (idx === 0) {
        createFromQuery();
        return;
      }
      idx -= 1;
    }
    if (showSearchAll && idx === 0) {
      goSearchAll();
    }
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
      <div
        ref={panelRef}
        className="folio-qs"
        role="dialog"
        aria-modal="true"
        aria-label="Quick switcher"
        data-testid="quick-switcher"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
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
                  data-testid="quick-switcher-result"
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
            <div className="folio-qs__fulltext" data-testid="fulltext-results">
              <div className="folio-qs__section-label">Full-text matches</div>
              {filteredText.map((r, j) => {
                const i = titleResults.length + j;
                return (
                  <div
                    key={r.note.id}
                    className={`folio-qs__row${i === activeIndex ? ' is-active' : ''}`}
                    data-testid="quick-switcher-result"
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
            </div>
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

          {showSearchAll &&
            (() => {
              const i = titleResults.length + filteredText.length + (showCreate ? 1 : 0);
              return (
                <div
                  className={`folio-qs__row folio-qs__row--search-all${i === activeIndex ? ' is-active' : ''}`}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => goSearchAll()}
                >
                  <span className="folio-qs__row-icon" aria-hidden="true">
                    <Icon name="search" size={14} />
                  </span>
                  <span className="folio-qs__row-main">
                    <span className="folio-qs__row-title">Search all notes for "{q}" →</span>
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
