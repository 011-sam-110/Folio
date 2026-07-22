// Upload + file-picking helpers for the 3D model node.
//
// Models are stored the same way images are: the bytes go into a Postgres `attachments`
// row and are served back at `/uploads/<stored_name>` (see server/src/lib/attachments.ts
// and routes/uploads.ts). The viewer then fetches that URL to render - which is same-origin,
// so it clears the app's `connect-src 'self'` CSP without any host allow-listing.
//
// -----------------------------------------------------------------------------------------
// SERVER SEAM (the parent must wire one small change for uploads to succeed)
// -----------------------------------------------------------------------------------------
// There is no ready-made endpoint that stores an arbitrary binary as an attachment today:
//   - POST /api/import         runs AI extraction and only accepts photo|slides|transcript.
//   - POST /api/import/image   is byte-generic but rejects anything whose mimetype is not
//                              image/* and hard-codes kind='image'.
// This helper posts to /api/import/image with `kind=file` in the form. To make model uploads
// work end to end the parent should either:
//   (a) relax /api/import/image to read `kind` from the body (default 'image') and skip the
//       image-only mimetype gate when kind==='file' - about four lines - OR
//   (b) add a dedicated POST /api/import/file that writes kind='file' and returns
//       { url, attachmentId } (recommended: it also lets us persist the attachment id).
// The `attachments.kind` column already documents 'file' as a valid value, so NO schema
// change is needed. Point MODEL_UPLOAD_URL at the chosen route.
// -----------------------------------------------------------------------------------------

export const MODEL_UPLOAD_URL = '/api/import/file';

/** Formats the viewer can render. glb/gltf go through <model-viewer>; stl/obj through three.js. */
export type Model3dFormat = 'glb' | 'gltf' | 'stl' | 'obj';

/** Accept string for the file picker: extensions plus the two MIME types browsers reliably set. */
export const MODEL_ACCEPT = '.glb,.gltf,.stl,.obj,model/gltf-binary,model/gltf+json';

/**
 * Client-side size ceiling. The task's target is 25 MB and that is what a local/self-hosted
 * server accepts. NOTE: the deployed app runs on Vercel, which rejects request bodies over
 * ~4.5 MB before they reach Express (imports.ts caps at 4 MB there and answers 413). We keep
 * the friendlier 25 MB gate here and surface the server's own "File is too large" message if
 * the platform limit bites first.
 */
export const MAX_MODEL_BYTES = 25 * 1024 * 1024;

const EXT_FORMAT: Record<string, Model3dFormat> = { glb: 'glb', gltf: 'gltf', stl: 'stl', obj: 'obj' };

/** Resolve a model format from a filename, or null if the extension is not one we support. */
export function formatFromName(name: string): Model3dFormat | null {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  return EXT_FORMAT[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** Human-friendly byte size for labels and error copy ("24.6 MB"). */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

// A File cannot live in a ProseMirror attribute (it is not JSON), so `run()` stashes the
// picked file here and passes only a short key through the node's attrs. The node view claims
// it on mount and uploads it. Memory-only, so a reloaded note never re-uploads a stale key.
const pending = new Map<string, File>();
let seq = 0;

export function stashPendingUpload(file: File): string {
  const key = `m3d-${Date.now().toString(36)}-${seq++}`;
  pending.set(key, file);
  return key;
}

export function takePendingUpload(key: string): File | undefined {
  const file = pending.get(key);
  if (file) pending.delete(key);
  return file;
}

/**
 * Open a native file picker for a single model file.
 * `onPick(null)` fires if the dialog is dismissed, so callers can clean up either way.
 */
export function pickModelFile(onPick: (file: File | null) => void): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = MODEL_ACCEPT;
  input.style.display = 'none';
  let settled = false;
  const done = (file: File | null) => {
    if (settled) return;
    settled = true;
    input.remove();
    onPick(file);
  };
  input.addEventListener('change', () => done(input.files?.[0] ?? null));
  // Modern browsers fire 'cancel' when the dialog is dismissed; the window-focus fallback
  // covers the rest (the change event, if it is coming, wins the race via `settled`).
  input.addEventListener('cancel', () => done(null));
  window.addEventListener('focus', () => window.setTimeout(() => done(null), 400), { once: true });
  document.body.appendChild(input);
  input.click();
}

export interface UploadResult {
  /** `/uploads/<stored_name>` - the bytes the viewer fetches, and the reference the server
   *  keys the attachment->note association on (lib/attachments.ts claimAttachmentsForNote). */
  url: string;
  /** Populated only when the (recommended) dedicated endpoint returns it. */
  attachmentId?: string;
}

/**
 * Upload a model file and resolve with its stored URL. Rejects with a user-facing message on
 * an oversize file, a network failure, or a non-2xx response (the server's error text is
 * surfaced verbatim). `onProgress` reports 0..1 of the upload.
 */
export function uploadModel(file: File, onProgress?: (fraction: number) => void): Promise<UploadResult> {
  if (file.size > MAX_MODEL_BYTES) {
    return Promise.reject(
      new Error(`That file is ${humanSize(file.size)}. Models need to be under ${humanSize(MAX_MODEL_BYTES)}.`),
    );
  }
  const form = new FormData();
  form.append('file', file);
  form.append('kind', 'file');

  return new Promise<UploadResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', MODEL_UPLOAD_URL);
    xhr.responseType = 'json';
    if (onProgress) {
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      });
    }
    xhr.addEventListener('load', () => {
      const body = (xhr.response ?? null) as { url?: string; attachmentId?: string; error?: string } | null;
      if (xhr.status >= 200 && xhr.status < 300 && body?.url) {
        resolve({ url: body.url, attachmentId: body.attachmentId });
      } else {
        reject(new Error(body?.error || `Upload failed (${xhr.status || 'no response'}).`));
      }
    });
    xhr.addEventListener('error', () => reject(new Error('Upload failed - check your connection and try again.')));
    xhr.addEventListener('abort', () => reject(new Error('Upload cancelled.')));
    xhr.send(form);
  });
}
