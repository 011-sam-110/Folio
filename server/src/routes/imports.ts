import { Router, type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { UPLOADS_DIR } from '../config.js';
import { db, newId, nowIso } from '../db.js';
import { chat, AiError, capForAi } from '../ai/client.js';
import { ocrPhotoPrompt, slidesRestructurePrompt, transcriptNotesPrompt, improvePrompt, titlePrompt, cleanTitle } from '../ai/prompts.js';
import { extractFromUpload } from '../lib/extract.js';
import { markdownToTipTap, markdownToPlainText, stripLeadingTitleHeading } from '../lib/markdown.js';
import { syncLinksForNote, resolveNoteIdByTitle } from '../lib/links.js';
import { createJob, updateJob, getJob } from '../lib/jobs.js';
import type { NoteRow } from '../lib/serialize.js';

const router = Router();

const MAX_SIZE = 25 * 1024 * 1024;

const MIME_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
};
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.pdf', '.txt', '.md', '.pptx', '.docx']);

function safeExt(originalName: string, mime: string): string {
  const fromMime = MIME_EXT[mime];
  if (fromMime) return fromMime;
  const ext = path.extname(originalName).toLowerCase();
  return ALLOWED_EXT.has(ext) ? ext : '';
}

function fileFilter(_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (MIME_EXT[file.mimetype] || ALLOWED_EXT.has(ext)) return cb(null, true);
  cb(new Error(`Unsupported file type: ${file.mimetype || ext || 'unknown'}`));
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => cb(null, `${newId()}${safeExt(file.originalname, file.mimetype)}`),
});

const upload = multer({ storage, limits: { fileSize: MAX_SIZE }, fileFilter });
const uploadImage = multer({ storage, limits: { fileSize: MAX_SIZE } });

/** Wraps a multer single-file middleware so upload errors become clean JSON, not a 500. */
function handleUpload(mw: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    mw(req, res, (err: unknown) => {
      if (!err) return next();
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ error: 'File is too large (max 25MB)' });
        return;
      }
      const message = err instanceof Error ? err.message : 'upload failed';
      res.status(400).json({ error: message });
    });
  };
}

type ImportKind = 'photo' | 'slides' | 'transcript';
type ImportMode = 'new' | 'append' | 'improve';
const KINDS: ImportKind[] = ['photo', 'slides', 'transcript'];
const MODES: ImportMode[] = ['new', 'append', 'improve'];

// PPTX/DOCX are handled by officeparser (see lib/extract.ts) — the slides/transcript
// kinds accept them too, matching the client's advertised accept lists (import/kinds.ts).
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export function kindAccepts(kind: ImportKind, mime: string, name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  if (kind === 'photo') return /^image\/(jpeg|png|webp|heic|heif)$/.test(mime) || ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'].includes(ext);
  if (kind === 'slides') return mime === 'application/pdf' || mime === PPTX_MIME || ext === '.pdf' || ext === '.pptx';
  return (
    mime === 'application/pdf' ||
    mime === 'text/plain' ||
    mime === 'text/markdown' ||
    mime === DOCX_MIME ||
    ['.pdf', '.txt', '.md', '.docx'].includes(ext)
  );
}

function markAttachment(id: string, status: string): void {
  db.prepare('UPDATE attachments SET status = ? WHERE id = ?').run(status, id);
}

function firstHeading(markdown: string): string {
  const m = markdown.match(/^#{1,6}\s+(.+)$/m);
  return m ? m[1].trim().slice(0, 200) : '';
}

// Re-exported for the unit tests; lives in lib/markdown.ts so seed.ts shares it.
export { stripLeadingTitleHeading };

// --- Per-note write serialization (fix: concurrent import writes to the same note) -------
// better-sqlite3 is synchronous, but import jobs run async (extraction + AI awaits before
// the write). Two jobs (or an import racing a live PATCH) targeting one note could otherwise
// interleave read → await → write and clobber each other. A per-note promise chain forces
// them through one at a time; each write itself re-reads fresh content inside a transaction.
const noteLocks = new Map<string, Promise<unknown>>();
export function withNoteLock<T>(noteId: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = noteLocks.get(noteId) ?? Promise.resolve();
  const result = prev.then(() => fn(), () => fn());
  const settled = result.then(() => {}, () => {});
  noteLocks.set(noteId, settled);
  void settled.then(() => {
    if (noteLocks.get(noteId) === settled) noteLocks.delete(noteId);
  });
  return result;
}

function titleFromFilename(name: string): string {
  const base = name.replace(/\.[^./]+$/, '');
  const cleaned = base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || 'Imported note';
}

async function resolveTitle(markdown: string, contentText: string, originalName: string): Promise<string> {
  try {
    const { text } = await chat(titlePrompt(capForAi(contentText || markdown, 8_000)));
    const cleaned = cleanTitle(text);
    if (cleaned) return cleaned;
  } catch {
    // AI title generation failing shouldn't fail the whole import — fall back below.
  }
  return firstHeading(markdown) || titleFromFilename(originalName);
}

async function createNoteFromMarkdown(markdown: string, notebookId: string, originalName: string): Promise<string> {
  const title = await resolveTitle(markdown, markdownToPlainText(markdown), originalName);
  // Don't duplicate the title as the first body heading (fix: imported notes showed it twice).
  const body = stripLeadingTitleHeading(markdown, title);
  const contentJson = markdownToTipTap(body, resolveNoteIdByTitle);
  const contentText = markdownToPlainText(body);

  const id = newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO notes (id, notebook_id, title, content_json, content_text, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, notebookId, title, JSON.stringify(contentJson), contentText, now, now);
  syncLinksForNote(id, contentText);
  return id;
}

/** Append extracted markdown to a note, re-reading its FRESH content inside a transaction so
 *  a concurrent write can't be clobbered. Serialized per note via withNoteLock. */
export function appendMarkdownToNote(noteId: string, markdown: string): string {
  const newJson = markdownToTipTap(markdown, resolveNoteIdByTitle) as { type: 'doc'; content?: unknown[] };
  const appendText = markdownToPlainText(markdown);
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId) as NoteRow | undefined;
    if (!row) throw new Error('target note no longer exists');
    const existingJson = JSON.parse(row.content_json) as { type: 'doc'; content?: unknown[] };
    const mergedContent = [...(existingJson.content ?? []), ...(newJson.content ?? [])];
    const mergedJson = { type: 'doc', content: mergedContent.length ? mergedContent : [{ type: 'paragraph' }] };
    const mergedText = [row.content_text, appendText].filter(Boolean).join('\n\n');
    db.prepare('UPDATE notes SET content_json = ?, content_text = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(mergedJson),
      mergedText,
      nowIso(),
      noteId,
    );
    syncLinksForNote(noteId, mergedText);
  });
  tx();
  return noteId;
}

async function mergeMarkdownIntoNote(noteId: string, markdown: string): Promise<string> {
  // Read a snapshot for the AI prompt (this is the only async step — it happens BEFORE the
  // write transaction re-reads, so the transaction can detect a concurrent change).
  const snapshot = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId) as NoteRow | undefined;
  if (!snapshot) throw new Error('target note no longer exists');

  const combined = capForAi(
    `EXISTING NOTES:\n\n${snapshot.content_text || '(empty)'}\n\n---\n\nNEW MATERIAL TO INTEGRATE:\n\n${markdown}`,
  );
  const instruction =
    'Merge the NEW MATERIAL into the EXISTING NOTES into one coherent, deduplicated set of notes. Preserve every fact from both — do not drop anything. ' +
    'Where they overlap, keep the clearer/more complete version. Add new sections for genuinely new topics. Keep the existing structure where it still fits.';
  const { text } = await chat(improvePrompt(combined, instruction));
  const mergedMarkdown = text.trim();

  const tx = db.transaction(() => {
    const fresh = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId) as NoteRow | undefined;
    if (!fresh) throw new Error('target note no longer exists');
    // Snapshot the note as it was BEFORE this merge, per contract (cause 'import').
    db.prepare("INSERT INTO note_versions (note_id, title, content_json, cause) VALUES (?, ?, ?, 'import')").run(
      noteId,
      fresh.title,
      fresh.content_json,
    );

    let mergedText: string;
    let mergedJsonStr: string;
    if (fresh.content_text === snapshot.content_text) {
      // No concurrent change: the AI's blended result is authoritative.
      mergedText = markdownToPlainText(mergedMarkdown);
      mergedJsonStr = JSON.stringify(markdownToTipTap(mergedMarkdown, resolveNoteIdByTitle));
    } else {
      // The note changed during the AI call — the blended result is stale. Degrade to a
      // non-destructive append of the extracted material so nothing the other writer added
      // is lost (better a slightly-less-tidy merge than silent data loss).
      const existingJson = JSON.parse(fresh.content_json) as { type: 'doc'; content?: unknown[] };
      const addJson = markdownToTipTap(markdown, resolveNoteIdByTitle) as { type: 'doc'; content?: unknown[] };
      const content = [...(existingJson.content ?? []), ...(addJson.content ?? [])];
      mergedJsonStr = JSON.stringify({ type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] });
      mergedText = [fresh.content_text, markdownToPlainText(markdown)].filter(Boolean).join('\n\n');
    }

    db.prepare('UPDATE notes SET content_json = ?, content_text = ?, updated_at = ? WHERE id = ?').run(
      mergedJsonStr,
      mergedText,
      nowIso(),
      noteId,
    );
    syncLinksForNote(noteId, mergedText);
  });
  tx();
  return noteId;
}

interface ProcessArgs {
  jobId: string;
  attachmentId: string;
  filePath: string;
  mime: string;
  originalName: string;
  kind: ImportKind;
  mode: ImportMode;
  notebookId?: string;
  noteId?: string;
}

async function processImport(args: ProcessArgs): Promise<void> {
  const { jobId, attachmentId, filePath, mime, originalName, kind, mode, notebookId, noteId } = args;
  updateJob(jobId, { status: 'running', step: 'Extracting text…' });
  markAttachment(attachmentId, 'extracting');

  try {
    let extractedMarkdown: string;

    if (kind === 'photo') {
      const buf = await fs.promises.readFile(filePath);
      const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
      const messages = ocrPhotoPrompt();
      const userMsg = messages[1];
      if (Array.isArray(userMsg.content)) userMsg.content.push({ type: 'image_url', image_url: { url: dataUrl } });
      const { text } = await chat(messages, { vision: true });
      extractedMarkdown = text.trim();
    } else if (kind === 'slides') {
      const { text: rawText } = await extractFromUpload(filePath, mime, originalName);
      const pages = rawText
        .split(/\n\n--- Page \d+ ---\n\n/)
        .map(s => s.trim())
        .filter(Boolean);
      updateJob(jobId, { step: 'Improving with AI…' });
      const { text } = await chat(slidesRestructurePrompt(pages.length ? pages : [rawText]));
      extractedMarkdown = text.trim();
    } else {
      const { text: rawText } = await extractFromUpload(filePath, mime, originalName);
      updateJob(jobId, { step: 'Improving with AI…' });
      const { text } = await chat(transcriptNotesPrompt(rawText));
      extractedMarkdown = text.trim();
    }

    updateJob(jobId, { step: 'Saving note…' });

    let resultNoteId: string;
    if (mode === 'new') {
      resultNoteId = await createNoteFromMarkdown(extractedMarkdown, notebookId!, originalName);
    } else if (mode === 'append') {
      // Serialize per note so concurrent imports (or an import racing another append) can't
      // read-modify-write over each other.
      resultNoteId = await withNoteLock(noteId!, () => appendMarkdownToNote(noteId!, extractedMarkdown));
    } else {
      resultNoteId = await withNoteLock(noteId!, () => mergeMarkdownIntoNote(noteId!, extractedMarkdown));
    }

    db.prepare('UPDATE attachments SET extracted_text = ?, status = ?, note_id = ? WHERE id = ?').run(
      extractedMarkdown,
      'ready',
      resultNoteId,
      attachmentId,
    );
    updateJob(jobId, { status: 'done', step: 'Done', noteId: resultNoteId });
  } catch (err) {
    // AiError's own message already lists which models were tried; other errors just
    // get their plain message (falling back to a generic one for non-Error throws).
    const message = err instanceof Error ? err.message : 'Import failed';
    markAttachment(attachmentId, 'failed');
    updateJob(jobId, { status: 'failed', error: message });
  }
}

// POST /api/import — multipart: file, kind, notebookId?, noteId?, mode?
router.post('/', handleUpload(upload.single('file')), (req, res) => {
  const file = req.file;
  const body = (req.body ?? {}) as { kind?: string; notebookId?: string; noteId?: string; mode?: string };
  const kind = body.kind as ImportKind | undefined;
  const mode = (body.mode as ImportMode | undefined) ?? 'new';
  const notebookId = body.notebookId?.trim() || undefined;
  const noteId = body.noteId?.trim() || undefined;

  const fail = (status: number, error: string) => {
    if (file) fs.unlink(file.path, () => {});
    res.status(status).json({ error });
  };

  if (!file) return fail(400, 'file is required');
  if (!kind || !KINDS.includes(kind)) return fail(400, `kind must be one of: ${KINDS.join(', ')}`);
  if (!MODES.includes(mode)) return fail(400, `mode must be one of: ${MODES.join(', ')}`);
  if (!kindAccepts(kind, file.mimetype, file.originalname)) return fail(400, `file does not look like a ${kind} (got ${file.mimetype || 'unknown type'})`);
  if (mode === 'new' && !notebookId) return fail(400, 'notebookId is required for mode "new"');
  if ((mode === 'append' || mode === 'improve') && !noteId) return fail(400, `noteId is required for mode "${mode}"`);

  if (notebookId) {
    const nb = db.prepare('SELECT id FROM notebooks WHERE id = ?').get(notebookId);
    if (!nb) return fail(400, 'unknown notebookId');
  }
  let targetNote: NoteRow | undefined;
  if (noteId) {
    targetNote = db.prepare('SELECT * FROM notes WHERE id = ? AND deleted_at IS NULL').get(noteId) as NoteRow | undefined;
    if (!targetNote) return fail(400, 'unknown noteId');
  }

  const attachmentId = newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO attachments (id, note_id, kind, original_name, stored_name, mime, size, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'uploaded', ?)`,
  ).run(attachmentId, targetNote?.id ?? null, kind, file.originalname, path.basename(file.path), file.mimetype, file.size, now);

  const jobId = newId();
  createJob(jobId, { status: 'queued', attachmentId });
  res.json({ jobId });

  setImmediate(() => {
    processImport({
      jobId,
      attachmentId,
      filePath: file.path,
      mime: file.mimetype,
      originalName: file.originalname,
      kind,
      mode,
      notebookId,
      noteId,
    }).catch(err => {
      console.error('[folio] import job crashed', jobId, err);
      updateJob(jobId, { status: 'failed', error: err instanceof Error ? err.message : 'Import failed' });
    });
  });
});

// GET /api/import/jobs/:id
router.get('/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json(job);
});

// POST /api/import/image — plain image upload for embedding in the editor.
router.post('/image', handleUpload(uploadImage.single('file')), (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'file is required' });
  if (!file.mimetype.startsWith('image/')) {
    fs.unlink(file.path, () => {});
    return res.status(400).json({ error: 'file must be an image' });
  }
  res.json({ url: `/uploads/${path.basename(file.path)}` });
});

export default router;
