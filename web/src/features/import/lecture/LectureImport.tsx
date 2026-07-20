// Lecture video import: pick -> scan for slides -> REVIEW the filmstrip -> transcribe -> note.
//
// The review step is deliberately mandatory. Slide detection is a heuristic (measured at ~94%
// precision on real lectures), so roughly one slide in sixteen is a false positive. Dropping
// those into a note unseen would make the student clean up inside the editor afterwards, which
// is much more work than deleting a thumbnail here.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Icon from '../../../components/Icon';
import Spinner from '../../../components/Spinner';
import { formatBytes } from '../kinds';
import { extractSlides, loadVideo, type SlideImage, type ExtractProgress } from './extractSlides';
import { decodeAudioTo16kMono, estimateAudioMemoryMb } from './audio';
import { MODELS, MODEL_ORDER, formatDuration, estimateTranscribeSeconds, hasWebGPU, type WhisperSize } from './models';
import { useTranscription } from './useTranscription';
import { buildLectureNote, titleFromFilename, formatTimestamp } from './buildNote';
import { uploadSlides, createLectureNote } from './lectureApi';
import type { TranscriptChunk } from './transcribeWorker';
import './lecture.css';

type Phase = 'pick' | 'scanning' | 'review' | 'working' | 'done' | 'error';

export interface LectureImportProps {
  notebookId: string;
  onBusyChange?: (busy: boolean) => void;
  onClose: () => void;
  onImported?: (noteId: string) => void;
}

const MAX_REASONABLE_MINUTES = 240;

export default function LectureImport({ notebookId, onBusyChange, onClose, onImported }: LectureImportProps) {
  const [file, setFile] = useState<File | null>(null);
  const [duration, setDuration] = useState(0);
  const [phase, setPhase] = useState<Phase>('pick');
  const [scan, setScan] = useState<ExtractProgress | null>(null);
  const [slides, setSlides] = useState<SlideImage[]>([]);
  const [removed, setRemoved] = useState<Set<number>>(new Set());
  const [size, setSize] = useState<WhisperSize>('base');
  const [withTranscript, setWithTranscript] = useState(true);
  const [step, setStep] = useState('');
  const [uploadDone, setUploadDone] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [resultNoteId, setResultNoteId] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const slidesRef = useRef<SlideImage[]>([]);
  const navigate = useNavigate();
  const { state: tx, run: runTranscription, cancel: cancelTranscription, reset: resetTranscription } = useTranscription();

  const webgpu = useMemo(() => hasWebGPU(), []);
  const busy = phase === 'scanning' || phase === 'working';

  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);

  // Slide previews are object URLs; leaking them pins every decoded frame in memory.
  useEffect(() => { slidesRef.current = slides; }, [slides]);
  useEffect(() => () => { slidesRef.current.forEach(s => URL.revokeObjectURL(s.url)); }, []);

  const releaseSlides = useCallback(() => {
    slidesRef.current.forEach(s => URL.revokeObjectURL(s.url));
    slidesRef.current = [];
    setSlides([]);
    setRemoved(new Set());
  }, []);

  const kept = useMemo(() => slides.filter((_, i) => !removed.has(i)), [slides, removed]);

  const handlePick = useCallback(async (picked: File) => {
    if (!picked.type.startsWith('video/') && !/\.(mp4|webm|mov|m4v|mkv)$/i.test(picked.name)) {
      setError('That does not look like a video file. MP4 works best.');
      return;
    }
    setError(null);
    releaseSlides();
    resetTranscription();
    try {
      const { video, url } = await loadVideo(picked);
      const secs = video.duration;
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      if (secs / 60 > MAX_REASONABLE_MINUTES) {
        setError(`That video is ${formatDuration(secs)} long — too long to process in a browser tab.`);
        return;
      }
      setFile(picked);
      setDuration(secs);
      setPhase('pick');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open that video');
    }
  }, [releaseSlides, resetTranscription]);

  const startScan = useCallback(async () => {
    if (!file) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('scanning');
    setError(null);
    setScan({ phase: 'scanning', progress: 0, found: 0, currentTime: 0, duration });
    try {
      const found = await extractSlides(file, {
        signal: controller.signal,
        onProgress: setScan,
      });
      setSlides(found);
      setRemoved(new Set());
      setPhase('review');
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        setPhase('pick');
        return;
      }
      setError(err instanceof Error ? err.message : 'Slide detection failed');
      setPhase('error');
    } finally {
      abortRef.current = null;
    }
  }, [file, duration]);

  const commit = useCallback(async () => {
    if (!file) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('working');
    setError(null);
    setUploadDone(0);

    try {
      let chunks: TranscriptChunk[] = [];
      if (withTranscript) {
        setStep('Extracting audio…');
        const audio = await decodeAudioTo16kMono(file, duration, controller.signal);
        setStep('Transcribing…');
        chunks = await runTranscription(audio.samples, audio.sampleRate, size);
      }

      setStep(kept.length ? `Uploading ${kept.length} slides…` : 'Preparing note…');
      const uploaded = await uploadSlides(kept, d => setUploadDone(d), controller.signal);

      setStep('Creating note…');
      const { doc, text } = buildLectureNote({
        slides: uploaded,
        chunks,
        durationSeconds: duration,
        sourceName: file.name,
        includeTranscript: withTranscript,
      });
      const { note } = await createLectureNote({
        notebookId,
        title: titleFromFilename(file.name),
        contentJson: doc,
        contentText: text,
      });
      setResultNoteId(note.id);
      setPhase('done');
      onImported?.(note.id);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        setPhase('review');
        return;
      }
      setError(err instanceof Error ? err.message : 'Import failed');
      setPhase('error');
    } finally {
      abortRef.current = null;
      setStep('');
    }
  }, [file, withTranscript, duration, size, kept, notebookId, runTranscription, onImported]);

  const cancelAll = useCallback(() => {
    abortRef.current?.abort();
    cancelTranscription();
  }, [cancelTranscription]);

  const model = MODELS[size];
  const estSeconds = estimateTranscribeSeconds(model, duration, webgpu);
  const memoryMb = file ? estimateAudioMemoryMb(duration, file.size) : 0;

  // ---------- pick ----------
  if (phase === 'pick') {
    return (
      <div className="lec">
        <div
          className={`im-drop${dragActive ? ' is-active' : ''}`}
          onDragOver={e => { e.preventDefault(); setDragActive(true); }}
          onDragLeave={() => setDragActive(false)}
          onDrop={e => {
            e.preventDefault();
            setDragActive(false);
            const f = e.dataTransfer.files[0];
            if (f) void handlePick(f);
          }}
          onClick={() => inputRef.current?.click()}
          role="button"
          tabIndex={0}
          aria-label="Drop or browse for a lecture video"
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click(); }
          }}
        >
          <div className="im-drop__icon" aria-hidden="true"><Icon name="layers" size={26} /></div>
          <div className="im-drop__label">Drop a lecture recording here, or click to browse</div>
          <div className="im-drop__hint">MP4, WebM or MOV · any size — the video stays on your device</div>
          <input
            ref={inputRef}
            type="file"
            accept="video/*,.mp4,.webm,.mov,.m4v,.mkv"
            hidden
            onChange={e => {
              const f = e.target.files?.[0];
              if (f) void handlePick(f);
              e.target.value = '';
            }}
          />
        </div>

        {error && <div className="im-error-inline">{error}</div>}

        {file && (
          <>
            <div className="lec-file">
              <span className="lec-file__icon" aria-hidden="true"><Icon name="layers" size={18} /></span>
              <div className="lec-file__meta">
                <div className="lec-file__name">{file.name}</div>
                <div className="lec-file__sub">{formatDuration(duration)} · {formatBytes(file.size)}</div>
              </div>
              <button type="button" className="im-icon-btn" aria-label="Remove video" onClick={() => { setFile(null); setError(null); }}>×</button>
            </div>
            <p className="lec-note">
              Folio reads the slides and audio out of this file in your browser. Only the slide
              images and the transcript are ever uploaded — the recording itself is not.
            </p>
          </>
        )}

        <div className="im-footer">
          <button type="button" className="im-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="im-btn im-btn--primary" disabled={!file} onClick={startScan}>
            Find slides
          </button>
        </div>
      </div>
    );
  }

  // ---------- scanning ----------
  if (phase === 'scanning') {
    const pct = Math.round((scan?.progress ?? 0) * 100);
    return (
      <div className="lec lec--center">
        <Spinner />
        <div className="lec-phase">
          {scan?.phase === 'capturing' ? 'Capturing slides…' : 'Scanning for slide changes…'}
        </div>
        <div className="lec-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="lec-bar__fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="lec-sub">
          {pct}% · {formatDuration(scan?.currentTime ?? 0)} of {formatDuration(duration)}
          {scan?.phase === 'capturing' && scan.found > 0 ? ` · ${scan.found} slides` : ''}
        </div>
        <div className="im-footer">
          <button type="button" className="im-btn" onClick={cancelAll}>Cancel</button>
        </div>
      </div>
    );
  }

  // ---------- review ----------
  if (phase === 'review') {
    return (
      <div className="lec">
        <div className="lec-review-head">
          <div>
            <strong>{kept.length}</strong> slide{kept.length === 1 ? '' : 's'} detected
            {removed.size > 0 && <span className="lec-muted"> · {removed.size} removed</span>}
          </div>
          <div className="lec-muted lec-review-head__hint">Click a slide to drop it from the note</div>
        </div>

        {slides.length === 0 ? (
          <div className="lec-empty">
            No slide changes found. That can happen with a talking-head recording — you can still
            import just the transcript.
          </div>
        ) : (
          <div className="lec-strip">
            {slides.map((s, i) => {
              const isOut = removed.has(i);
              return (
                <button
                  key={`${s.time}-${i}`}
                  type="button"
                  className={`lec-slide${isOut ? ' is-removed' : ''}`}
                  aria-pressed={!isOut}
                  aria-label={`Slide at ${formatTimestamp(s.startTime)}${isOut ? ' (removed)' : ''}`}
                  onClick={() => setRemoved(prev => {
                    const next = new Set(prev);
                    if (next.has(i)) next.delete(i); else next.add(i);
                    return next;
                  })}
                >
                  <img src={s.url} alt="" loading="lazy" />
                  <span className="lec-slide__time">{formatTimestamp(s.startTime)}</span>
                  <span className="lec-slide__mark" aria-hidden="true">
                    <Icon name={isOut ? 'plus' : 'x'} size={12} />
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <label className="lec-toggle">
          <input type="checkbox" checked={withTranscript} onChange={e => setWithTranscript(e.target.checked)} />
          <span>
            <strong>Transcribe the audio</strong> — adds what was said under each slide
          </span>
        </label>

        {withTranscript && (
          <div className="lec-models">
            <div className="lec-models__row" role="radiogroup" aria-label="Transcription model">
              {MODEL_ORDER.map(key => {
                const m = MODELS[key];
                return (
                  <button
                    key={key}
                    type="button"
                    role="radio"
                    aria-checked={size === key}
                    className={`lec-model${size === key ? ' is-active' : ''}`}
                    onClick={() => setSize(key)}
                  >
                    <span className="lec-model__name">{m.label}</span>
                    <span className="lec-model__acc">{m.accuracy}</span>
                    <span className="lec-model__meta">
                      {webgpu ? m.downloadMb.webgpu : m.downloadMb.wasm} MB ·
                      {' ~'}{formatDuration(estimateTranscribeSeconds(m, duration, webgpu))}
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="lec-model__detail">{model.detail}</p>
            <p className="lec-warn">
              <Icon name="info" size={14} />
              <span>
                First run downloads {webgpu ? model.downloadMb.webgpu : model.downloadMb.wasm} MB of model
                weights (cached for next time), then works for roughly{' '}
                <strong>{formatDuration(estSeconds)}</strong> on this {webgpu ? 'GPU' : 'CPU'}.
                {!webgpu && ' Your browser has no WebGPU, so this runs on CPU and is much slower.'}
                {' '}It needs about {memoryMb} MB of memory and you can cancel at any point.
              </span>
            </p>
          </div>
        )}

        {error && <div className="im-error-inline">{error}</div>}

        <div className="im-footer">
          <button type="button" className="im-btn" onClick={() => setPhase('pick')}>Back</button>
          <button
            type="button"
            className="im-btn im-btn--primary"
            disabled={kept.length === 0 && !withTranscript}
            onClick={commit}
          >
            Create note
          </button>
        </div>
      </div>
    );
  }

  // ---------- working ----------
  if (phase === 'working') {
    const downloading = tx.phase === 'loading-model' && tx.downloadProgress < 1;
    const pct = downloading
      ? Math.round(tx.downloadProgress * 100)
      : tx.phase === 'transcribing'
        ? Math.round(tx.progress * 100)
        : kept.length
          ? Math.round((uploadDone / kept.length) * 100)
          : 0;

    return (
      <div className="lec lec--center">
        <Spinner />
        <div className="lec-phase">
          {downloading ? 'Downloading model…' : tx.phase === 'transcribing' ? 'Transcribing…' : step || 'Working…'}
        </div>
        <div className="lec-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="lec-bar__fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="lec-sub">
          {downloading && `${pct}% of the ${webgpu ? model.downloadMb.webgpu : model.downloadMb.wasm} MB model`}
          {tx.phase === 'transcribing' && (
            <>
              {pct}% · {formatDuration(tx.processedSeconds)} of {formatDuration(tx.totalSeconds)}
              {' · '}elapsed {formatDuration(tx.elapsedSeconds)}
              {tx.etaSeconds !== null && ` · ~${formatDuration(tx.etaSeconds)} left`}
            </>
          )}
          {tx.phase !== 'transcribing' && !downloading && step.startsWith('Uploading') && `${uploadDone} of ${kept.length} slides`}
        </div>
        {tx.phase === 'transcribing' && (
          <div className="lec-live" aria-live="polite">
            {tx.chunks.slice(-2).map(c => c.text).join(' ') || '…'}
          </div>
        )}
        <div className="im-footer">
          <button type="button" className="im-btn" onClick={cancelAll}>Cancel</button>
        </div>
      </div>
    );
  }

  // ---------- done ----------
  if (phase === 'done') {
    return (
      <div className="im-result">
        <div className="im-result__icon im-result__icon--ok" aria-hidden="true">✓</div>
        <div className="im-result__title">Note ready</div>
        <div className="im-result__name">
          {kept.length} slide{kept.length === 1 ? '' : 's'}
          {withTranscript && tx.chunks.length > 0 && ` · ${tx.chunks.length} caption segments`}
        </div>
        <div className="im-footer">
          <button type="button" className="im-btn" onClick={onClose}>Close</button>
          <button
            type="button"
            className="im-btn im-btn--primary"
            onClick={() => {
              if (resultNoteId) navigate(`/note/${resultNoteId}`);
              onClose();
            }}
          >
            Open note
          </button>
        </div>
      </div>
    );
  }

  // ---------- error ----------
  return (
    <div className="im-result">
      <div className="im-result__icon im-result__icon--error" aria-hidden="true">⚠️</div>
      <div className="im-result__title">Import failed</div>
      {(error || tx.error) && <div className="im-result__message">{error ?? tx.error}</div>}
      <div className="im-footer">
        <button type="button" className="im-btn" onClick={onClose}>Cancel</button>
        <button
          type="button"
          className="im-btn im-btn--primary"
          onClick={() => { setError(null); setPhase(slides.length ? 'review' : 'pick'); }}
        >
          Back
        </button>
      </div>
    </div>
  );
}
