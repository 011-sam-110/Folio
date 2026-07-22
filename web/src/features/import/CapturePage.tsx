// Mobile-first standalone capture page — rendered outside the App shell
// (see main.tsx). Full-viewport, no sidebar. Downscales photos client-side
// before handing off to the same import job pipeline as ImportModal.
import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import type { Notebook } from '../../lib/types';
import Icon from '../../components/Icon';
import { IMPORT_KINDS, findKind, formatBytes, validateFile, type ImportKind } from './kinds';
import { downscaleImage } from './downscale';
import { useImportJob } from './useImportJob';
import ImportProgress from './ImportProgress';
import './import-ui.css';
import './CapturePage.css';

type Phase = 'pick' | 'ready' | 'uploading' | 'done' | 'error';

export default function CapturePage() {
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [notebooksLoading, setNotebooksLoading] = useState(true);
  const [notebooksFailed, setNotebooksFailed] = useState(false);
  const [notebookId, setNotebookId] = useState<string | null>(null);
  const [kind, setKind] = useState<ImportKind>('photo');
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('pick');
  const [error, setError] = useState<string | null>(null);
  const [resultNoteId, setResultNoteId] = useState<string | null>(null);
  const [resultTitle, setResultTitle] = useState<string | null>(null);
  // Multi-page session: after the first successful capture, "Add another page" chains the
  // next upload as mode=append into the note just created (mirrors ImportModal's chaining)
  // so a 3-page handout becomes ONE note, not three fragments.
  const [appendTarget, setAppendTarget] = useState<{ id: string; title: string | null } | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { job, run, reset: resetJob } = useImportJob();

  useEffect(() => {
    api.notebooks()
      .then(res => {
        setNotebooks(res.notebooks);
        setNotebookId(prev => prev ?? res.notebooks[0]?.id ?? null);
      })
      .catch(() => setNotebooksFailed(true))
      .finally(() => setNotebooksLoading(false));
  }, []);

  useEffect(() => {
    if (kind !== 'photo' || !file) { setPreviewUrl(null); return; }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file, kind]);

  const kindMeta = findKind(kind);

  function handleKindChange(next: ImportKind) {
    setKind(next);
    setFile(null);
    setError(null);
    if (phase !== 'uploading') setPhase('pick');
  }

  function openPicker() {
    inputRef.current?.click();
  }

  function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    const chosen = e.target.files?.[0];
    e.target.value = '';
    if (!chosen) return;
    acceptFile(chosen);
  }

  function acceptFile(chosen: File) {
    const err = validateFile(chosen, kind);
    if (err) { setError(err); return; }
    setError(null);
    setFile(chosen);
    setPhase('ready');
  }

  // Desktop fallback: /capture also accepts drag-drop, not just the camera tap target.
  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) acceptFile(dropped);
  }

  async function upload() {
    if (!file || (!notebookId && !appendTarget)) return;
    setPhase('uploading');
    setError(null);
    try {
      const uploadFile = kind === 'photo' ? await downscaleImage(file) : file;
      const form = new FormData();
      form.append('file', uploadFile);
      form.append('kind', kind);
      if (appendTarget) {
        form.append('mode', 'append');
        form.append('noteId', appendTarget.id);
      } else {
        form.append('mode', 'new');
        form.append('notebookId', notebookId!);
      }
      const { jobId } = await api.import(form);
      const result = await run(jobId);
      if (result.status === 'failed') {
        setError(result.error ?? 'Import failed');
        setPhase('error');
        return;
      }
      setResultNoteId(result.noteId ?? null);
      if (result.noteId) {
        try {
          const noteRes = await api.note(result.noteId);
          setResultTitle(noteRes.note.title || 'Untitled note');
        } catch {
          setResultTitle(null);
        }
      }
      setPhase('done');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Upload failed. Check your connection and try again');
      setPhase('error');
    }
  }

  function resetPicker() {
    setFile(null);
    setPreviewUrl(null);
    setPhase('pick');
    setError(null);
    setResultNoteId(null);
    resetJob();
  }

  /** Chain the next capture into the note just created (multi-page lecture sheet). */
  function addAnotherPage() {
    if (resultNoteId) setAppendTarget({ id: resultNoteId, title: resultTitle });
    resetPicker();
  }

  /** Start a fresh note instead (escape hatch out of the chaining session). */
  function captureAnother() {
    setAppendTarget(null);
    setResultTitle(null);
    resetPicker();
  }

  return (
    <div className="cp-page">
      <header className="cp-header">
        <div className="cp-wordmark">Unote</div>
        <div className="cp-tagline">Capture a page in seconds</div>
      </header>

      <div className="cp-body">
        {phase === 'done' ? (
          <div className="cp-success">
            <div className="cp-success__icon" aria-hidden="true">✓</div>
            <h2>{appendTarget ? 'Page added' : 'Note ready'}</h2>
            {resultTitle && <p className="cp-success__title">{resultTitle}</p>}
            <p className="cp-success__message">Captured! It's on your desktop too.</p>
            <div className="cp-success__actions">
              <button type="button" className="im-btn im-btn--primary" onClick={addAnotherPage}>Add another page</button>
              <button type="button" className="im-btn" onClick={captureAnother}>Start a new note</button>
              {resultNoteId && <Link className="im-link-btn" to={`/note/${resultNoteId}`}>Open note</Link>}
            </div>
          </div>
        ) : phase === 'uploading' ? (
          <div className="cp-progress">
            <ImportProgress job={job} compact />
          </div>
        ) : (
          <>
            <div className="cp-kind-switch" role="tablist" aria-label="Import kind">
              {IMPORT_KINDS.map(k => (
                <button
                  key={k.key}
                  type="button"
                  role="tab"
                  aria-selected={kind === k.key}
                  className={`cp-kind${kind === k.key ? ' is-active' : ''}`}
                  onClick={() => handleKindChange(k.key)}
                >
                  <Icon name={k.iconName} size={16} />
                  <span>{k.label}</span>
                </button>
              ))}
            </div>

            {appendTarget ? (
              <div className="cp-append-banner" data-testid="capture-append-banner">
                <span>
                  Adding to <strong>{appendTarget.title || 'your note'}</strong>
                </span>
                <button type="button" className="im-link-btn" onClick={captureAnother}>
                  Start a new note instead
                </button>
              </div>
            ) : (
            /* This is a single-select list of notebooks, not a set of tabs: there are
               no tabpanels behind it. It was role="tablist" with plain buttons inside,
               which is an invalid parent/child pairing (axe: aria-required-children).
               radiogroup/radio states the same thing correctly, and aria-checked makes
               the current selection audible rather than colour-only. The loading and
               error hints render OUTSIDE the group, because a radiogroup may only
               contain radios. */
            notebooksLoading ? (
              <div className="cp-notebooks__hint" role="status">Loading notebooks…</div>
            ) : notebooksFailed ? (
              <div className="cp-notebooks__hint" role="alert">Couldn't load notebooks. Check your connection</div>
            ) : notebooks.length === 0 ? (
              <div className="cp-notebooks__hint">Create a notebook on desktop first</div>
            ) : (
              <div className="cp-notebooks" role="radiogroup" aria-label="Notebook">
                {notebooks.map(nb => (
                  <button
                    key={nb.id}
                    type="button"
                    role="radio"
                    aria-checked={notebookId === nb.id}
                    className={`im-chip${notebookId === nb.id ? ' is-active' : ''}`}
                    onClick={() => setNotebookId(nb.id)}
                  >
                    {nb.emoji} {nb.name}
                  </button>
                ))}
              </div>
            )
            )}

            {error && (
              <div className="cp-error">
                <p>{error}</p>
                <button type="button" className="im-btn" onClick={() => setPhase(file ? 'ready' : 'pick')}>Dismiss</button>
              </div>
            )}

            <div
              className={`cp-dropzone${dragActive ? ' is-active' : ''}`}
              onDragOver={e => { e.preventDefault(); setDragActive(true); }}
              onDragLeave={() => setDragActive(false)}
              onDrop={onDrop}
            >
              {file ? (
                <div className="cp-preview">
                  {previewUrl ? (
                    <img className="cp-preview__image" src={previewUrl} alt="Selected page preview" />
                  ) : (
                    <div className="cp-preview__file">
                      <span className="cp-preview__file-icon" aria-hidden="true"><Icon name={kindMeta.iconName} size={28} /></span>
                      <div>
                        <div className="cp-preview__file-name">{file.name}</div>
                        <div className="cp-preview__file-size">{formatBytes(file.size)}</div>
                      </div>
                    </div>
                  )}
                  <button type="button" className="im-link-btn" onClick={openPicker}>Choose a different file</button>
                </div>
              ) : (
                <button type="button" className="cp-cta" onClick={openPicker}>
                  <span className="cp-cta__icon" aria-hidden="true"><Icon name={kindMeta.iconName} size={40} /></span>
                  <span className="cp-cta__label">{kindMeta.label}</span>
                  <span className="cp-cta__hint">{kindMeta.hint}</span>
                  <span className="cp-cta__drop-hint">or drop a file here</span>
                </button>
              )}
            </div>

            <input
              ref={inputRef}
              type="file"
              accept={kindMeta.accept}
              capture={kind === 'photo' ? 'environment' : undefined}
              onChange={onFileChange}
              hidden
            />
          </>
        )}
      </div>

      {phase === 'ready' && file && (
        <div className="cp-sticky">
          <button type="button" className="im-btn im-btn--primary cp-sticky__btn" disabled={!notebookId && !appendTarget} onClick={upload}>
            {appendTarget ? 'Upload & add to note' : 'Upload & process'}
          </button>
        </div>
      )}
    </div>
  );
}
