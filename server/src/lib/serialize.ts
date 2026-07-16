import { db } from '../db.js';

export interface NotebookLiteRow { id: string; name: string; emoji: string; color: string }

const notebookLiteStmt = () => db.prepare('SELECT id, name, emoji, color FROM notebooks WHERE id = ?');
const tagsStmt = () => db.prepare('SELECT tag FROM note_tags WHERE note_id = ? ORDER BY tag');
const attachmentsStmt = () =>
  db.prepare(
    `SELECT id, kind, original_name, stored_name, mime, size, status, created_at
     FROM attachments WHERE note_id = ? AND status != 'failed' ORDER BY created_at ASC`,
  );

export interface AttachmentDto {
  id: string;
  kind: string;
  originalName: string;
  url: string;
  mime: string;
  size: number;
  status: string;
  createdAt: string;
}

/** Attachments (photo/pdf/office originals) kept next to a note so an OCR'd source is
 *  always one click away — "never destructive OCR". */
export function attachmentsOf(noteId: string): AttachmentDto[] {
  const rows = attachmentsStmt().all(noteId) as Array<{
    id: string; kind: string; original_name: string; stored_name: string; mime: string; size: number; status: string; created_at: string;
  }>;
  return rows.map(r => ({
    id: r.id,
    kind: r.kind,
    originalName: r.original_name,
    url: `/uploads/${r.stored_name}`,
    mime: r.mime,
    size: r.size,
    status: r.status,
    createdAt: r.created_at,
  }));
}

export function snippetOf(text: string, len = 160): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, len);
}

export function wordCountOf(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

export function notebookLite(id: string): NotebookLiteRow | null {
  return (notebookLiteStmt().get(id) as NotebookLiteRow | undefined) ?? null;
}

export function tagsOf(noteId: string): string[] {
  return (tagsStmt().all(noteId) as Array<{ tag: string }>).map(r => r.tag);
}

// Raw notes table row (snake_case as stored).
export interface NoteRow {
  id: string; notebook_id: string; title: string; content_json: string; content_text: string;
  pinned: number; archived: number; created_at: string; updated_at: string; rowid?: number;
}

export function noteLite(row: NoteRow) {
  return {
    id: row.id,
    notebookId: row.notebook_id,
    title: row.title,
    snippet: snippetOf(row.content_text),
    pinned: Boolean(row.pinned),
    archived: Boolean(row.archived),
    updatedAt: row.updated_at,
    createdAt: row.created_at,
    tags: tagsOf(row.id),
    notebook: notebookLite(row.notebook_id),
    wordCount: wordCountOf(row.content_text),
  };
}

export function noteFull(row: NoteRow) {
  return {
    id: row.id,
    notebookId: row.notebook_id,
    title: row.title,
    contentJson: JSON.parse(row.content_json),
    contentText: row.content_text,
    pinned: Boolean(row.pinned),
    archived: Boolean(row.archived),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tags: tagsOf(row.id),
    notebook: notebookLite(row.notebook_id),
    attachments: attachmentsOf(row.id),
  };
}
