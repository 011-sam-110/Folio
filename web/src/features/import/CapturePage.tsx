// Mobile-first standalone capture page — rendered outside the App shell
// (see main.tsx). Full-viewport, no sidebar. Downscales photos client-side
// before handing off to the same import job pipeline as ImportModal.
import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import type { Notebook } from '../../lib/types';
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
    if (!file || !notebookId) return;
    setPhase('uploading');
    setError(null);
    try {
      const uploadFile = kind === 'photo' ? await downscaleImage(file) : file;
      const form = new FormData();
      form.append('file', uploadFile);
      form.append('kind', kind);
      form.append('notebookId', notebookId);
      form.append('mode', 'new');
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
      setError(err instanceof ApiError ? err.message : 'Upload failed — check your connection and try again');
      setPhase('error');
    }
  }

  function captureAnother() {
    setFile(null);
    setPreviewUrl(null);
    setPhase('pick');
    setError(null);
    setResultNoteId(null);
    setResultTitle(null);
    resetJob();
  }

  return (
    <div className="cp-page">
      <header className="cp-header">
        <div className="cp-wordmark">Folio</div>
        <div className="cp-tagline">Capture a page in seconds</div>
      </header>

      <div className="cp-body">
        {phase === 'done' ? (
          <div className="cp-success">
            <div className="cp-success__icon" aria-hidden="true">✓</div>
            <h2>Note ready</h2>
            {resultTitle && <p className="cp-success__title">{resultTitle}</p>}
            <p className="cp-success__message">Captured! It's on your desktop too.</p>
            <div className="cp-success__actions">
              <button type="button" className="im-btn im-btn--primary" onClick={captureAnother}>Capture another</button>
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
                  <span aria-hidden="true">{k.icon}</span>
                  <span>{k.label}</span>
                </button>
              ))}
            </div>

            <div className="cp-notebooks" role="tablist" aria-label="Notebook">
              {notebooksLoading ? (
                <div className="cp-notebooks__hint">Loading notebooks…</div>
              ) : notebooksFailed ? (
                <div className="cp-notebooks__hint">Couldn't load notebooks — check your connection</div>
              ) : notebooks.length === 0 ? (
                <div className="cp-notebooks__hint">Create a notebook on desktop first</div>
              ) : (
                notebooks.map(nb => (
                  <button
                    key={nb.id}
                    type="button"
                    className={`im-chip${notebookId === nb.id ? ' is-active' : ''}`}
                    onClick={() => setNotebookId(nb.id)}
                  >
                    {nb.emoji} {nb.name}
                  </button>
                ))
              )}
            </div>

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
                      <span className="cp-preview__file-icon" aria-hidden="true">{kindMeta.icon}</span>
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
                  <span className="cp-cta__icon" aria-hidden="true">{kindMeta.icon}</span>
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
          <button type="button" className="im-btn im-btn--primary cp-sticky__btn" disabled={!notebookId} onClick={upload}>
            Upload &amp; process
          </button>
        </div>
      )}
    </div>
  );
}
