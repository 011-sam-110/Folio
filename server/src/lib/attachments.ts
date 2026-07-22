// Attachment payloads live in Postgres (attachments.bytes), not on local disk.
//
// The deployed app runs as a Vercel serverless function, whose filesystem is read-only
// apart from /tmp - and /tmp does not survive between invocations. Writing uploads to
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
  /** Owner. Always the session user - never anything from the request body. */
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
 * stored_name is `newId()` + extension - 14 characters of 36-symbol randomness, so
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

/** The `/uploads/<stored_name>` URL shape note content carries. Bounded to the same
 *  length routes/uploads.ts accepts, so a pathological body cannot make this scan wide. */
const UPLOAD_REF_RE = /\/uploads\/([A-Za-z0-9._-]{1,128})/g;

/**
 * File the caller's own not-yet-attached attachments against the note that references them.
 *
 * Why this exists: a share-link guest loads embedded images as plain `<img src="/uploads/…">`
 * requests, and the only thing authorising those reads is `attachments.note_id = <shared note>`.
 * Editor uploads carry no note_id - the image is posted before it is placed, so the note is not
 * known yet - and that gap used to be papered over on the read side by checking whether the
 * note's *body text* mentioned the URL. That was authorisation by requester-writable data:
 * a guest holding an edit share could type any `/uploads/<name>` into the note they were given
 * and the server would hand back those bytes. The association is therefore recorded here, on
 * an owner-authenticated write, and the read path is left trusting only the column.
 *
 * Both predicates in the UPDATE are load-bearing:
 *  - `user_id = ?` is the session user, never a value from the request body, so an owner can
 *    only ever claim rows they already own. content_json is owner-controlled at this point,
 *    but it cannot reach across an account boundary.
 *  - `note_id IS NULL` means a claim never re-points an attachment already filed against some
 *    other note, so quoting an existing image URL cannot steal it.
 *
 * Deliberately never called from the share-link guest write path: a guest must not be able to
 * manufacture the relationship that grants them access.
 */
export async function claimAttachmentsForNote(
  uid: string,
  noteId: string,
  contentJson: string,
): Promise<void> {
  const names = new Set<string>();
  for (const m of contentJson.matchAll(UPLOAD_REF_RE)) names.add(m[1]);
  for (const storedName of names) {
    await db
      .prepare(
        'UPDATE attachments SET note_id = ? WHERE stored_name = ? AND user_id = ? AND note_id IS NULL',
      )
      .run(noteId, storedName, uid);
  }
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
