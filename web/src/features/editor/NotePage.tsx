// The editor page (`/note/:noteId`) — the crown jewel. Loads the note, then hands off
// to NoteWorkspace (keyed by note id) which owns the title, TipTap editor, autosave,
// history/AI/import affordances and the backlinks sections.
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Editor } from '@tiptap/core';
import { api, ApiError } from '../../lib/api';
import type { Note, NoteLite } from '../../lib/types';
import { relativeTime, formatDate, plural } from '../../lib/format';
import { toast } from '../../components/Toast';
import EmptyState from '../../components/EmptyState';
import Skeleton from '../../components/Skeleton';
import NoteCard from '../../components/NoteCard';
import FolioEditor from './FolioEditor';
import OutlinePane from './OutlinePane';
import HistoryPanel from './HistoryPanel';
import AiPreviewModal from './AiPreviewModal';
import DropdownButton from './DropdownButton';
import ImportModal from '../import/ImportModal';
import { useAutosave } from './useAutosave';
import { setActiveFlush } from './autosaveBus';
import { markdownToSafeHtml } from './markdown';
import type { OutlineItem } from './outline';
import './notePage.css';

export default function NotePage() {
  const { noteId } = useParams<{ noteId: string }>();
  const [state, setState] = useState<{ note: Note; backlinks: NoteLite[] } | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'notfound' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('');

  const load = useCallback((id: string) => {
    setStatus('loading');
    api
      .note(id)
      .then(({ note, backlinks }) => {
        setState({ note, backlinks });
        setStatus('ready');
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 404) setStatus('notfound');
        else {
          setErrorMsg(e instanceof Error ? e.message : 'Failed to load note');
          setStatus('error');
        }
      });
  }, []);

  useEffect(() => {
    if (noteId) load(noteId);
  }, [noteId, load]);

  if (status === 'loading') {
    return (
      <div className="folio-note-page">
        <div className="folio-note-main">
          <div className="folio-note-shell">
            <Skeleton lines={1} />
            <div style={{ height: 40 }} />
            <Skeleton lines={8} />
          </div>
        </div>
      </div>
    );
  }

  if (status === 'notfound') {
    return (
      <div className="folio-note-missing">
        <EmptyState
          icon="🔍"
          title="Note not found"
          hint="It may have been deleted, or the link is broken."
          action={
            <Link className="folio-btn-primary" to="/">
              ← Back to dashboard
            </Link>
          }
        />
      </div>
    );
  }

  if (status === 'error' || !state) {
    return (
      <div className="folio-note-missing">
        <EmptyState
          icon="⚠️"
          title="Couldn't load this note"
          hint={errorMsg}
          action={
            <button type="button" className="folio-btn-primary" onClick={() => noteId && load(noteId)}>
              Retry
            </button>
          }
        />
      </div>
    );
  }

  return (
    <NoteWorkspace
      key={state.note.id}
      initialNote={state.note}
      initialBacklinks={state.backlinks}
      onReload={() => noteId && load(noteId)}
    />
  );
}

interface NoteWorkspaceProps {
  initialNote: Note;
  initialBacklinks: NoteLite[];
  onReload: () => void;
}

function NoteWorkspace({ initialNote, initialBacklinks, onReload }: NoteWorkspaceProps) {
  const navigate = useNavigate();
  const [note, setNote] = useState(initialNote);
  const [backlinks] = useState(initialBacklinks);
  const [unlinked, setUnlinked] = useState<NoteLite[] | null>(null);
  const [title, setTitle] = useState(initialNote.title);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importKind, setImportKind] = useState<'photo' | 'slides' | 'transcript'>('photo');
  const [aiBusy, setAiBusy] = useState<string | null>(null);
  const [flashcardStep, setFlashcardStep] = useState(false);
  const [flashcardBanner, setFlashcardBanner] = useState<number | null>(null);
  const [aiWholeResult, setAiWholeResult] = useState<{ kind: 'improve' | 'summarize'; model: string; markdown: string } | null>(null);
  const [wordCount, setWordCount] = useState(0);
  const [charCount, setCharCount] = useState(0);

  const editorRef = useRef<Editor | null>(null);
  const titleRef = useRef(title);
  titleRef.current = title;

  // Snapshot of the latest editable content, refreshed on every title/doc change.
  // The autosave flush reads THIS (not the live editor) so a pending save still
  // completes on blur/unmount even after the editor instance has been torn down
  // (e.g. the user inserts a wikilink and immediately clicks it to navigate away).
  const pendingRef = useRef<{ title: string; contentJson: unknown; contentText: string } | null>(null);

  const capturePending = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    pendingRef.current = {
      title: titleRef.current,
      contentJson: ed.getJSON(),
      contentText: ed.getText({ blockSeparator: '\n' }),
    };
  }, []);

  const autosave = useAutosave(
    note.id,
    () => pendingRef.current,
    (savedNote) => {
      setNote((prev) => ({ ...prev, updatedAt: savedNote.updatedAt, tags: savedNote.tags }));
    },
  );

  // Expose this note's flush so in-editor navigation (wikilink clicks) can persist
  // pending edits before leaving.
  useEffect(() => {
    setActiveFlush(autosave.flush);
    return () => setActiveFlush(null);
  }, [autosave.flush]);

  useEffect(() => {
    api
      .unlinkedMentions(note.id)
      .then((r) => setUnlinked(r.notes))
      .catch(() => setUnlinked([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id]);

  useEffect(() => {
    document.title = `${title || 'Untitled'} · Folio`;
  }, [title]);

  useEffect(() => {
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void manualSnapshot();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function manualSnapshot() {
    await autosave.flush();
    try {
      await api.snapshot(note.id);
      toast('Snapshot saved', 'ok');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Snapshot failed', 'error');
    }
  }

  function handleEditorReady(editor: Editor) {
    editorRef.current = editor;
    capturePending();
    setWordCount(editor.storage.characterCount?.words() ?? 0);
    setCharCount(editor.storage.characterCount?.characters() ?? 0);
  }
  function handleEditorDestroy() {
    editorRef.current = null;
  }
  function handleDocChange() {
    capturePending();
    autosave.schedule();
    const ed = editorRef.current;
    if (ed) {
      setWordCount(ed.storage.characterCount?.words() ?? 0);
      setCharCount(ed.storage.characterCount?.characters() ?? 0);
    }
  }

  function handleTitleChange(e: ChangeEvent<HTMLInputElement>) {
    setTitle(e.target.value);
    titleRef.current = e.target.value;
    capturePending();
    autosave.schedule();
  }
  function handleTitleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      editorRef.current?.commands.focus('start');
    }
  }

  async function togglePin() {
    const next = !note.pinned;
    setNote((n) => ({ ...n, pinned: next }));
    try {
      await api.updateNote(note.id, { pinned: next });
    } catch {
      setNote((n) => ({ ...n, pinned: !next }));
      toast('Could not update pin', 'error');
    }
  }

  function aiError(e: unknown) {
    if (e instanceof ApiError && e.status === 502) toast('AI offline — is the gateway running?', 'error');
    else toast(e instanceof Error ? e.message : 'AI request failed', 'error');
  }

  async function handleImprove(close: () => void) {
    close();
    setAiBusy('improve');
    try {
      const res = await api.aiImprove({ noteId: note.id });
      setAiWholeResult({ kind: 'improve', model: res.model, markdown: res.markdown });
    } catch (e) {
      aiError(e);
    } finally {
      setAiBusy(null);
    }
  }
  async function handleSummarize(close: () => void) {
    close();
    setAiBusy('summarize');
    try {
      const res = await api.aiSummarize(note.id);
      setAiWholeResult({ kind: 'summarize', model: res.model, markdown: res.markdown });
    } catch (e) {
      aiError(e);
    } finally {
      setAiBusy(null);
    }
  }
  async function handleTitleSuggest(close: () => void) {
    close();
    setAiBusy('title');
    try {
      const res = await api.aiTitle(note.id);
      setTitle(res.title);
      titleRef.current = res.title;
      capturePending();
      autosave.schedule();
      toast('Title updated', 'ok');
    } catch (e) {
      aiError(e);
    } finally {
      setAiBusy(null);
    }
  }
  async function handleFlashcards(count: number, close: () => void) {
    setFlashcardStep(false);
    close();
    setAiBusy('flashcards');
    try {
      const res = await api.aiFlashcards(note.id, count);
      setFlashcardBanner(res.cards.length);
      window.setTimeout(() => setFlashcardBanner(null), 7000);
    } catch (e) {
      aiError(e);
    } finally {
      setAiBusy(null);
    }
  }

  function applyImprove() {
    if (!aiWholeResult || !editorRef.current) return;
    const editor = editorRef.current;
    api
      .snapshot(note.id)
      .catch(() => {})
      .finally(() => {
        const html = markdownToSafeHtml(aiWholeResult.markdown);
        editor.commands.setContent(html, { emitUpdate: true });
        setAiWholeResult(null);
        toast('Improved note applied', 'ok');
      });
  }
  function applySummary() {
    if (!aiWholeResult || !editorRef.current) return;
    const bodyHtml = markdownToSafeHtml(aiWholeResult.markdown);
    const calloutHtml = `<div data-type="callout" data-emoji="🧭" data-tone="info"><h2>Summary</h2>${bodyHtml}</div>`;
    editorRef.current.chain().focus().insertContentAt(0, calloutHtml).run();
    setAiWholeResult(null);
    toast('Summary added to top of note', 'ok');
  }

  function openImport(kind: 'photo' | 'slides' | 'transcript', close: () => void) {
    close();
    setImportKind(kind);
    setImportOpen(true);
  }

  function handleTableOfContents() {
    const el = document.querySelector('.folio-outline');
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('folio-flash');
      window.setTimeout(() => el.classList.remove('folio-flash'), 1200);
    } else {
      toast('The outline panel needs a wider window (≥1200px)', 'info');
    }
  }

  const notebook = note.notebook;
  const savedLabel =
    autosave.status === 'saving'
      ? 'Saving…'
      : autosave.status === 'error'
        ? 'Save failed'
        : autosave.savedAt
          ? `Saved · ${relativeTime(autosave.savedAt.toISOString())}`
          : '';

  return (
    <div
      className="folio-note-page"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) void autosave.flush();
      }}
    >
      <div className="folio-note-main">
        <div className="folio-note-shell">
          <div className="folio-breadcrumb">
            <Link to={`/notebook/${notebook.id}`} className="folio-breadcrumb-notebook">
              {notebook.emoji} {notebook.name}
            </Link>
            <span className="folio-breadcrumb-sep">›</span>
            <span className="folio-breadcrumb-title">{title || 'Untitled'}</span>
          </div>

          <div className="folio-action-bar">
            <button
              type="button"
              className={`folio-btn-icon${note.pinned ? ' active' : ''}`}
              title={note.pinned ? 'Unpin' : 'Pin'}
              aria-label={note.pinned ? 'Unpin' : 'Pin'}
              onClick={togglePin}
            >
              {note.pinned ? '📌' : '📍'}
            </button>

            <DropdownButton
              label={
                <>
                  <span aria-hidden="true">✨</span> {aiBusy ? 'AI…' : 'AI'}
                </>
              }
              disabled={!!aiBusy}
            >
              {(close) => (
                <>
                  <button type="button" onClick={() => handleImprove(close)}>
                    Improve writing
                  </button>
                  <button type="button" onClick={() => handleSummarize(close)}>
                    Summarize
                  </button>
                  {!flashcardStep ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setFlashcardStep(true);
                      }}
                    >
                      Generate flashcards
                    </button>
                  ) : (
                    <div className="folio-flashcard-count">
                      <span>How many?</span>
                      {[5, 8, 12].map((n) => (
                        <button key={n} type="button" onClick={() => handleFlashcards(n, close)}>
                          {n}
                        </button>
                      ))}
                    </div>
                  )}
                  <button type="button" onClick={() => handleTitleSuggest(close)}>
                    Suggest title
                  </button>
                </>
              )}
            </DropdownButton>

            <DropdownButton label="Import into note">
              {(close) => (
                <>
                  <button type="button" onClick={() => openImport('photo', close)}>
                    📷 Photo of notes
                  </button>
                  <button type="button" onClick={() => openImport('slides', close)}>
                    📑 Slides PDF
                  </button>
                  <button type="button" onClick={() => openImport('transcript', close)}>
                    📝 Transcript
                  </button>
                </>
              )}
            </DropdownButton>

            <button type="button" className="folio-btn" onClick={() => setHistoryOpen(true)}>
              History
            </button>
            <button type="button" className="folio-btn" onClick={() => window.open(api.exportUrl(note.id), '_blank')}>
              Export .md
            </button>

            <div className="folio-info-wrap">
              <button type="button" className="folio-btn-icon" onClick={() => setInfoOpen((v) => !v)} aria-label="Note info">
                ℹ️
              </button>
              {infoOpen && (
                <div className="folio-info-popover" onMouseLeave={() => setInfoOpen(false)}>
                  <div>
                    {plural(wordCount, 'word')} · {plural(charCount, 'character')}
                  </div>
                  <div>Created {formatDate(note.createdAt)}</div>
                  <div>Updated {formatDate(note.updatedAt)}</div>
                  <div>{plural(backlinks.length, 'backlink')}</div>
                </div>
              )}
            </div>

            <span className={`folio-save-chip folio-save-${autosave.status}`} data-testid="autosave-status">
              {autosave.status === 'error' ? (
                <>
                  Save failed
                  <button type="button" onClick={() => autosave.flush()}>
                    Retry
                  </button>
                </>
              ) : (
                savedLabel
              )}
            </span>
          </div>

          <input
            className="folio-title-input"
            value={title}
            placeholder="Untitled"
            onChange={handleTitleChange}
            onKeyDown={handleTitleKeyDown}
          />

          <FolioEditor
            content={note.contentJson}
            notebookId={note.notebookId}
            onReady={handleEditorReady}
            onDestroy={handleEditorDestroy}
            onDocChange={handleDocChange}
            onOutline={setOutline}
            onTableOfContents={handleTableOfContents}
          />

          <section className="folio-links-section" data-testid="backlinks-section">
            <h4>Linked from {plural(backlinks.length, 'note')}</h4>
            {backlinks.length === 0 ? (
              <p className="folio-links-empty">No notes link here yet.</p>
            ) : (
              <div className="folio-links-grid">
                {backlinks.map((n) => (
                  <NoteCard key={n.id} note={n} onClick={() => navigate(`/note/${n.id}`)} />
                ))}
              </div>
            )}
          </section>

          {unlinked != null && unlinked.length > 0 && (
            <section className="folio-links-section">
              <h4>Unlinked mentions</h4>
              <div className="folio-links-grid">
                {unlinked.map((n) => (
                  <NoteCard key={n.id} note={n} onClick={() => navigate(`/note/${n.id}`)} />
                ))}
              </div>
            </section>
          )}
        </div>
      </div>

      <OutlinePane items={outline} editor={editorRef.current} />

      <HistoryPanel noteId={note.id} open={historyOpen} onClose={() => setHistoryOpen(false)} onRestored={onReload} />

      {aiWholeResult && (
        <AiPreviewModal
          open
          onClose={() => setAiWholeResult(null)}
          heading={aiWholeResult.kind === 'improve' ? 'AI: Improve writing' : 'AI: Summarize'}
          model={aiWholeResult.model}
          before={aiWholeResult.kind === 'improve' ? note.contentText.slice(0, 600) : null}
          afterMarkdown={aiWholeResult.markdown}
          actions={[
            aiWholeResult.kind === 'improve'
              ? { label: 'Apply', primary: true, onClick: applyImprove }
              : { label: 'Insert summary', primary: true, onClick: applySummary },
          ]}
        />
      )}

      {flashcardBanner != null && (
        <div className="folio-flashcard-banner">
          {flashcardBanner} flashcards added —{' '}
          <Link to="/study" onClick={() => setFlashcardBanner(null)}>
            Study now →
          </Link>
        </div>
      )}

      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} noteId={note.id} defaultKind={importKind} />
    </div>
  );
}
