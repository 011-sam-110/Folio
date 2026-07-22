// Presentational shell for the 3D model node. Pure: no TipTap, no three.js, no upload logic -
// just the card chrome for each state, driven by props. Kept separate from Model3dView so the
// visual states can be rendered and eyeballed on their own (and so the view stays about glue).
import type { Ref } from 'react';
import { humanSize } from './model3dUpload';

export type Model3dCardMode =
  | 'import' // no file yet - drop zone
  | 'uploading' // upload in flight
  | 'upload-error' // upload failed
  | 'idle' // uploaded, renderer not yet activated (poster / placeholder)
  | 'loading' // renderer activated, model loading
  | 'active' // model rendered
  | 'error'; // renderer / model-load failed

export interface Model3dCardProps {
  mode: Model3dCardMode;
  fileName?: string;
  format?: string | null;
  size?: number | null;
  poster?: string | null;
  /** 0..1 upload progress; when 0/undefined the bar is indeterminate. */
  progress?: number;
  error?: string;
  editable?: boolean;
  selected?: boolean;
  /** Host element the viewer backend mounts into (loading + active modes). */
  viewportRef?: Ref<HTMLDivElement>;
  onPick?: () => void;
  onActivate?: () => void;
  onRetry?: () => void;
  onRemove?: () => void;
}

function CubeIcon({ size = 22 }: { size?: number }) {
  return (
    <svg
      className="folio-model3d-cube"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <path d="m3.3 7 8.7 5 8.7-5" />
      <path d="M12 22V12" />
    </svg>
  );
}

export default function Model3dCard(props: Model3dCardProps) {
  const { mode, fileName, format, size, poster, progress, error, editable, selected, viewportRef } = props;
  const label = fileName || '3D model';
  // The viewport stays mounted across loading -> active -> error so the viewer element is never
  // torn out from under the backend; loading and error draw as overlays on top of it.
  const hasStage = mode === 'loading' || mode === 'active' || mode === 'error';

  return (
    <div className={`folio-model3d-root${selected ? ' is-selected' : ''}`} data-mode={mode}>
      {(editable || fileName) && (
        <div className="folio-model3d-bar" contentEditable={false}>
          <span className="folio-model3d-meta">
            {format && <span className="folio-model3d-badge">{format}</span>}
            <span className="folio-model3d-name" title={label}>{label}</span>
            {size ? <span className="folio-model3d-size">{humanSize(size)}</span> : null}
          </span>
          {editable && (
            <button
              type="button"
              className="folio-model3d-remove"
              aria-label="Remove 3D model"
              title="Remove"
              onClick={props.onRemove}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      )}

      {hasStage && (
        <div className="folio-model3d-stage">
          <div ref={viewportRef} className="folio-model3d-viewport" />
          {mode === 'loading' && (
            <div className="folio-model3d-overlay">
              <span className="folio-model3d-spinner" aria-hidden="true" />
              <span>Loading model...</span>
            </div>
          )}
          {mode === 'error' && (
            <div className="folio-model3d-overlay is-error" role="alert">
              <span className="folio-model3d-alert" aria-hidden="true">!</span>
              <span className="folio-model3d-title">Couldn&rsquo;t load this model</span>
              <span className="folio-model3d-hint">{error || (fileName ? fileName : 'The file could not be displayed.')}</span>
              <button type="button" className="folio-model3d-btn" onClick={props.onRetry}>Try again</button>
            </div>
          )}
        </div>
      )}
      {mode === 'active' && <p className="folio-model3d-caption">Drag to rotate, scroll to zoom</p>}

      {mode === 'import' && (
        <button type="button" className="folio-model3d-drop" onClick={props.onPick}>
          <CubeIcon size={30} />
          <span className="folio-model3d-title">Add a 3D model</span>
          <span className="folio-model3d-hint">GLB, glTF, STL or OBJ &middot; up to 25 MB</span>
          <span className="folio-model3d-btn" aria-hidden="true">Choose file</span>
        </button>
      )}

      {mode === 'uploading' && (
        <div className="folio-model3d-panel">
          <CubeIcon size={28} />
          <span className="folio-model3d-title">Uploading {fileName || 'model'}...</span>
          <span
            className={`folio-model3d-progress${progress ? '' : ' is-indeterminate'}`}
            role="progressbar"
            aria-label="Upload progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress ? Math.round(progress * 100) : undefined}
          >
            <span className="folio-model3d-progress-bar" style={progress ? { width: `${Math.round(progress * 100)}%` } : undefined} />
          </span>
        </div>
      )}

      {mode === 'upload-error' && (
        <div className="folio-model3d-panel">
          <span className="folio-model3d-alert" aria-hidden="true">!</span>
          <span className="folio-model3d-title">Upload failed</span>
          <span className="folio-model3d-hint">{error || 'Something went wrong.'}</span>
          <button type="button" className="folio-model3d-btn" onClick={props.onRetry}>Try again</button>
        </div>
      )}

      {mode === 'idle' && (
        <button
          type="button"
          className="folio-model3d-poster"
          onClick={props.onActivate}
          aria-label={`Load 3D model${fileName ? `: ${fileName}` : ''}`}
        >
          {poster ? (
            <img src={poster} alt="" className="folio-model3d-poster-img" />
          ) : (
            <span className="folio-model3d-poster-fill"><CubeIcon size={36} /></span>
          )}
          <span className="folio-model3d-play">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
            Load 3D model
          </span>
        </button>
      )}
    </div>
  );
}
