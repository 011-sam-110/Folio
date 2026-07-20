// Attachment payloads live in Postgres (attachments.bytes), not on local disk.
//
// The deployed app runs as a Vercel serverless function, whose filesystem is read-only
// apart from /tmp — and /tmp does not survive between invocations. Writing uploads to
// data/uploads/ therefore failed outright in production (EROFS) and would have been
// useless even if it had not: the next invocation reads a different, empty disk.
//
// So the row is the source of truth everywhere, local included. One code path, and what
// is exercised in development is what runs in production.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { db, newId, nowIso } from '../db.js';

/** Where a stored attachment is reachable. Existing note content already contains
 *  URLs of this exact shape, so it is a compatibility constraint, not a choice. */
export function attachmentUrl(storedName: string): string {
  return `/uploads/${storedName}`;
}

export interface AttachmentInput {
  /** Owner. Always the session user — never anything from the request body. */
  uid: string;
  noteId?: string | null;
  kind: string;
  originalName: string;
  storedName: string;
  mime: string;
  bytes: Buffer;
  status?: string;
}

/** Insert an attachment row with its payload. Returns the new row id. */
export async function insertAttachment(input: AttachmentInput): Promise<string> {
  const id = newId();
  await db
    .prepare(
      `INSERT INTO attachments
         (id, user_id, note_id, kind, original_name, stored_name, mime, size, bytes, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.uid,
      input.noteId ?? null,
      input.kind,
      input.originalName,
      input.storedName,
      input.mime,
      input.bytes.byteLength,
      input.bytes,
      input.status ?? 'uploaded',
      nowIso(),
    );
  return id;
}

export interface AttachmentRow {
  id: string;
  user_id: string;
  note_id: string | null;
  stored_name: string;
  mime: string;
  size: number;
  bytes: Buffer | null;
}

/**
 * Look an attachment up by the name embedded in its URL.
 *
 * stored_name is `newId()` + extension — 14 characters of 36-symbol randomness, so
 * roughly 72 bits. Collisions are not a practical concern, but the ORDER BY keeps the
 * choice deterministic rather than leaving it to Postgres' scan order if one ever did.
 */
export async function findAttachmentByStoredName(storedName: string): Promise<AttachmentRow | undefined> {
  return db
    .prepare(
      `SELECT id, user_id, note_id, stored_name, mime, size, bytes
         FROM attachments WHERE stored_name = ? ORDER BY created_at ASC LIMIT 1`,
    )
    .get<AttachmentRow>(storedName);
}

/**
 * Materialise bytes as a real file for the length of one call, then remove it.
 *
 * The extractors (unpdf, officeparser) and the .pptx figure reader all take a path
 * rather than a buffer. os.tmpdir() is the one writable location on a serverless
 * filesystem; the file only has to outlive the callback, so its non-persistence is
 * irrelevant here. Deleted in `finally` so a throwing extractor still cleans up.
 */
export async function withTempFile<T>(bytes: Buffer, ext: string, fn: (filePath: string) => Promise<T>): Promise<T> {
  const filePath = path.join(os.tmpdir(), `folio-${newId()}${ext}`);
  await fsp.writeFile(filePath, bytes);
  try {
    return await fn(filePath);
  } finally {
    await fsp.rm(filePath, { force: true }).catch(() => {});
  }
}
