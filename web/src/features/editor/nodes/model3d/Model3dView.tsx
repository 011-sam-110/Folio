// React node view for the 3D model node: owns upload, lazy activation, and viewer lifecycle,
// and delegates all rendering to the pure Model3dCard.
//
// Lifecycle:
//  - A freshly inserted node carries `uploadKey` (set by model3dInsertable.run) pointing at the
//    picked File held in memory. On mount we claim that File and upload it, then write the
//    resulting `url` into attrs. The manual "Choose file" path (import mode / retry) does the
//    same via handlePick.
//  - Once a `url` exists the card shows a poster/placeholder and stays inert until it is either
//    scrolled into view (IntersectionObserver) or clicked - only then is the heavy renderer
//    chunk dynamically imported and mounted.
import { useCallback, useEffect, useRef, useState } from 'react';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import Model3dCard, { type Model3dCardMode } from './Model3dCard';
import './model3d.css';
import {
  formatFromName,
  takePendingUpload,
  uploadModel,
  pickModelFile,
  MAX_MODEL_BYTES,
  humanSize,
  type Model3dFormat,
} from './model3dUpload';

type UploadState =
  | { status: 'idle' }
  | { status: 'uploading'; progress: number }
  | { status: 'error'; error: string };

type ViewerStatus = 'loading' | 'active' | 'error';

export default function Model3dView({ node, updateAttributes, editor, selected, deleteNode }: NodeViewProps) {
  const url = (node.attrs.url as string | null) ?? null;
  const format = (node.attrs.format as Model3dFormat | null) ?? null;
  const fileName = (node.attrs.fileName as string) || '';
  const size = (node.attrs.size as number | null) ?? null;
  const poster = (node.attrs.poster as string | null) ?? null;
  const uploadKey = (node.attrs.uploadKey as string | null) ?? null;
  const editable = editor.isEditable;

  const [upload, setUpload] = useState<UploadState>({ status: 'idle' });
  const [activated, setActivated] = useState(false);
  const [status, setStatus] = useState<ViewerStatus>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [reloadNonce, setReloadNonce] = useState(0);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const startedRef = useRef(false);

  const startUpload = useCallback(
    (file: File) => {
      setUpload({ status: 'uploading', progress: 0 });
      uploadModel(file, (fraction) =>
        setUpload((prev) => (prev.status === 'uploading' ? { status: 'uploading', progress: fraction } : prev)),
      )
        .then((result) => {
          setUpload({ status: 'idle' });
          updateAttributes({
            url: result.url,
            attachmentId: result.attachmentId ?? null,
            uploadKey: null,
            size: file.size,
            fileName: file.name,
            format: formatFromName(file.name),
          });
        })
        .catch((err: unknown) => {
          setUpload({ status: 'error', error: err instanceof Error ? err.message : 'Upload failed.' });
        });
    },
    [updateAttributes],
  );

  // Claim the in-memory File a freshly-inserted node points at, and upload it. Runs once.
  useEffect(() => {
    if (startedRef.current || url || !uploadKey) return;
    startedRef.current = true;
    const file = takePendingUpload(uploadKey);
    if (!file) {
      // Stale key (e.g. the note was reloaded mid-upload) - fall back to the import UI.
      updateAttributes({ uploadKey: null });
      return;
    }
    startUpload(file);
  }, [url, uploadKey, updateAttributes, startUpload]);

  // Manual pick: the import drop zone and the "try again" after an upload error.
  const handlePick = useCallback(() => {
    pickModelFile((file) => {
      if (!file) return;
      if (!formatFromName(file.name)) {
        setUpload({ status: 'error', error: 'That is not a supported model. Use GLB, glTF, STL or OBJ.' });
        return;
      }
      if (file.size > MAX_MODEL_BYTES) {
        setUpload({
          status: 'error',
          error: `That file is ${humanSize(file.size)}. Models need to be under ${humanSize(MAX_MODEL_BYTES)}.`,
        });
        return;
      }
      updateAttributes({ fileName: file.name, format: formatFromName(file.name) });
      startUpload(file);
    });
  }, [startUpload, updateAttributes]);

  // Lazy activation: mount the renderer when scrolled into view (or on click via handleActivate).
  useEffect(() => {
    if (activated || !url) return;
    const host = rootRef.current;
    if (!host || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setActivated(true);
          io.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    io.observe(host);
    return () => io.disconnect();
  }, [activated, url]);

  // Mount / dispose the viewer backend. Re-runs only on (de)activation, a source change, or a
  // retry - never on the loading->active status transition, so a loaded model is not remounted.
  useEffect(() => {
    if (!activated || !url || !format || status === 'error') return;
    const host = viewportRef.current;
    if (!host) return;
    let disposed = false;
    let dispose: (() => void) | null = null;
    (async () => {
      try {
        const backend =
          format === 'glb' || format === 'gltf'
            ? await import('./modelViewerMount')
            : await import('./threeViewerMount');
        if (disposed) return;
        dispose = backend.mountViewer(host, {
          url,
          format,
          onLoad: () => {
            if (!disposed) setStatus('active');
          },
          onError: (message) => {
            if (disposed) return;
            setErrorMsg(message);
            setStatus('error');
          },
        });
      } catch {
        if (!disposed) {
          setErrorMsg('Could not load the 3D viewer.');
          setStatus('error');
        }
      }
    })();
    return () => {
      disposed = true;
      dispose?.();
    };
    // status is intentionally excluded: only re-mount on these keys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activated, url, format, reloadNonce]);

  const handleActivate = useCallback(() => setActivated(true), []);
  const handleViewerRetry = useCallback(() => {
    setErrorMsg('');
    setStatus('loading');
    setReloadNonce((n) => n + 1);
  }, []);

  let mode: Model3dCardMode;
  if (upload.status === 'uploading') mode = 'uploading';
  else if (upload.status === 'error') mode = 'upload-error';
  else if (!url) mode = 'import';
  else if (!activated) mode = 'idle';
  else mode = status; // loading | active | error

  const cardError = upload.status === 'error' ? upload.error : errorMsg;
  const progress = upload.status === 'uploading' ? upload.progress : undefined;

  return (
    <NodeViewWrapper className="folio-model3d" data-format={format ?? undefined}>
      <div ref={rootRef}>
        <Model3dCard
          mode={mode}
          fileName={fileName}
          format={format}
          size={size}
          poster={poster}
          progress={progress}
          error={cardError}
          editable={editable}
          selected={selected}
          viewportRef={viewportRef}
          onPick={handlePick}
          onActivate={handleActivate}
          onRetry={mode === 'upload-error' ? handlePick : handleViewerRetry}
          onRemove={deleteNode}
        />
      </div>
    </NodeViewWrapper>
  );
}
