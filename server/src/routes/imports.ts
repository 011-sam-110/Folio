import { Router, type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { UPLOADS_DIR } from '../config.js';
import { db, newId, nowIso } from '../db.js';
import { chat, AiError } from '../ai/client.js';
import { ocrPhotoPrompt, slidesRestructurePrompt, transcriptNotesPrompt, improvePrompt, titlePrompt, cleanTitle } from '../ai/prompts.js';
import { extractFromUpload } from '../lib/extract.js';
import { markdownToTipTap, markdownToPlainText } from '../lib/markdown.js';
import { createJob, updateJob, getJob } from '../lib/jobs.js';
import type { NoteRow } from '../lib/serialize.js';

const router = Router();

const MAX_SIZE = 25 * 1024 * 1024;
const WIKILINK_RE = /\[\[([^[\]]+)\]\]/g;

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

function kindAccepts(kind: ImportKind, mime: string, name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  if (kind === 'photo') return /^image\/(jpeg|png|webp|heic|heif)$/.test(mime) || ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'].includes(ext);
  if (kind === 'slides') return mime === 'application/pdf' || ext === '.pdf';
  return mime === 'application/pdf' || mime === 'text/plain' || mime === 'text/markdown' || ['.pdf', '.txt', '.md'].includes(ext);
}

function markAttachment(id: string, status: string): void {
  db.prepare('UPDATE attachments SET status = ? WHERE id = ?').run(status, id);
}

/** Extracts [[Title]] refs from note text and rewrites the `links` rows for this note. */
function syncLinks(fromNoteId: string, contentText: string): void {
  const titles = new Set<string>();
  WIKILINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKILINK_RE.exec(contentText))) titles.add(m[1].trim().toLowerCase());

  db.prepare('DELETE FROM links WHERE from_note_id = ?').run(fromNoteId);
  if (titles.size === 0) return;

  const findByTitle = db.prepare('SELECT id FROM notes WHERE lower(title) = ? AND id != ?');
  const insertLink = db.prepare('INSERT OR IGNORE INTO links (from_note_id, to_note_id) VALUES (?, ?)');
  for (const title of titles) {
    const target = findByTitle.get(title, fromNoteId) as { id: string } | undefined;
    if (target) insertLink.run(fromNoteId, target.id);
  }
}

function firstHeading(markdown: string): string {
  const m = markdown.match(/^#{1,6}\s+(.+)$/m);
  return m ? m[1].trim().slice(0, 200) : '';
}

function titleFromFilename(name: string): string {
  const base = name.replace(/\.[^./]+$/, '');
  const cleaned = base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || 'Imported note';
}

async function resolveTitle(markdown: string, contentText: string, originalName: string): Promise<string> {
  try {
    const { text } = await chat(titlePrompt(contentText || markdown));
    const cleaned = cleanTitle(text);
    if (cleaned) return cleaned;
  } catch {
    // AI title generation failing shouldn't fail the whole import — fall back below.
  }
  return firstHeading(markdown) || titleFromFilename(originalName);
}

async function createNoteFromMarkdown(markdown: string, notebookId: string, originalName: string): Promise<string> {
  const contentJson = markdownToTipTap(markdown);
  const contentText = markdownToPlainText(markdown);
  const title = await resolveTitle(markdown, contentText, originalName);

  const id = newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO notes (id, notebook_id, title, content_json, content_text, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, notebookId, title, JSON.stringify(contentJson), contentText, now, now);
  syncLinks(id, contentText);
  return id;
}

function appendMarkdownToNote(noteId: string, markdown: string): string {
  const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId) as NoteRow;
  const existingJson = JSON.parse(row.content_json) as { type: 'doc'; content?: unknown[] };
  const newJson = markdownToTipTap(markdown) as { type: 'doc'; content?: unknown[] };
  const mergedContent = [...(existingJson.content ?? []), ...(newJson.content ?? [])];
  const mergedJson = { type: 'doc', content: mergedContent.length ? mergedContent : [{ type: 'paragraph' }] };
  const mergedText = [row.content_text, markdownToPlainText(markdown)].filter(Boolean).join('\n\n');

  const now = nowIso();
  db.prepare('UPDATE notes SET content_json = ?, content_text = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(mergedJson),
    mergedText,
    now,
    noteId,
  );
  syncLinks(noteId, mergedText);
  return noteId;
}

async function mergeMarkdownIntoNote(noteId: string, markdown: string): Promise<string> {
  const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId) as NoteRow;

  // Snapshot the note as it was BEFORE the AI merge, per contract.
  db.prepare("INSERT INTO note_versions (note_id, title, content_json, cause) VALUES (?, ?, ?, 'import')").run(
    noteId,
    row.title,
    row.content_json,
  );

  const combined = `EXISTING NOTES:\n\n${row.content_text || '(empty)'}\n\n---\n\nNEW MATERIAL TO INTEGRATE:\n\n${markdown}`;
  const instruction =
    'Merge the NEW MATERIAL into the EXISTING NOTES into one coherent, deduplicated set of notes. Preserve every fact from both — do not drop anything. ' +
    'Where they overlap, keep the clearer/more complete version. Add new sections for genuinely new topics. Keep the existing structure where it still fits.';
  const { text } = await chat(improvePrompt(combined, instruction));
  const mergedMarkdown = text.trim();

  const mergedJson = markdownToTipTap(mergedMarkdown);
  const mergedText = markdownToPlainText(mergedMarkdown);
  const now = nowIso();
  db.prepare('UPDATE notes SET content_json = ?, content_text = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(mergedJson),
    mergedText,
    now,
    noteId,
  );
  syncLinks(noteId, mergedText);
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
      resultNoteId = appendMarkdownToNote(noteId!, extractedMarkdown);
    } else {
      resultNoteId = await mergeMarkdownIntoNote(noteId!, extractedMarkdown);
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
    targetNote = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId) as NoteRow | undefined;
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
