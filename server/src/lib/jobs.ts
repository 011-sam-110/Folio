// Import job progress, stored in Postgres.
//
// This was a process-local Map, which works on one long-lived server and not at all
// on serverless: the client polls GET /api/import/jobs/:id, each poll can land on a
// different instance, and an instance that did not start the job answers "job not
// found" for a job running perfectly well elsewhere. Every import on the deployed
// app therefore appeared to vanish the moment it was submitted.
//
// Jobs are still ephemeral in spirit — losing one only costs a re-import — but they
// have to be visible to whichever instance the next request happens to reach.
import { db, nowIso } from '../db.js';

export type ImportJobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface ImportJob {
  id: string;
  status: ImportJobStatus;
  step?: string;
  noteId?: string;
  error?: string;
  attachmentId?: string;
}

interface JobRow {
  id: string;
  status: ImportJobStatus;
  step: string | null;
  note_id: string | null;
  error: string | null;
  attachment_id: string | null;
}

function toJob(row: JobRow): ImportJob {
  const job: ImportJob = { id: row.id, status: row.status };
  if (row.step) job.step = row.step;
  if (row.note_id) job.noteId = row.note_id;
  if (row.error) job.error = row.error;
  if (row.attachment_id) job.attachmentId = row.attachment_id;
  return job;
}

export async function createJob(
  id: string,
  userId: string,
  patch: Partial<Omit<ImportJob, 'id'>> = {},
): Promise<ImportJob> {
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO import_jobs (id, user_id, status, step, note_id, attachment_id, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      userId,
      patch.status ?? 'queued',
      patch.step ?? null,
      patch.noteId ?? null,
      patch.attachmentId ?? null,
      patch.error ?? null,
      now,
      now,
    );
  return { id, status: patch.status ?? 'queued', ...patch };
}

/**
 * Patch a job. COALESCE keeps unspecified fields untouched, so a progress update
 * that only sets `step` cannot blank out the noteId an earlier update recorded.
 */
export async function updateJob(
  id: string,
  patch: Partial<Omit<ImportJob, 'id'>>,
): Promise<ImportJob | null> {
  const r = await db
    .prepare(
      `UPDATE import_jobs
          SET status = COALESCE(?, status),
              step = COALESCE(?, step),
              note_id = COALESCE(?, note_id),
              attachment_id = COALESCE(?, attachment_id),
              error = COALESCE(?, error),
              updated_at = ?
        WHERE id = ?`,
    )
    .run(
      patch.status ?? null,
      patch.step ?? null,
      patch.noteId ?? null,
      patch.attachmentId ?? null,
      patch.error ?? null,
      nowIso(),
      id,
    );
  if (r.changes === 0) return null;
  return getJob(id);
}

/**
 * Read a job. Scoped by owner when a user id is supplied — job ids are short, and
 * an unscoped read would leak other people's import progress and the note ids it
 * produced.
 */
export async function getJob(id: string, userId?: string): Promise<ImportJob | null> {
  const row = userId
    ? await db
        .prepare('SELECT * FROM import_jobs WHERE id = ? AND user_id = ?')
        .get<JobRow>(id, userId)
    : await db.prepare('SELECT * FROM import_jobs WHERE id = ?').get<JobRow>(id);
  return row ? toJob(row) : null;
}

/** Drop settled jobs older than `hours`. Called opportunistically on job creation. */
export async function purgeOldJobs(hours = 24): Promise<number> {
  const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();
  const r = await db
    .prepare("DELETE FROM import_jobs WHERE status IN ('done','failed') AND updated_at < ?")
    .run(cutoff);
  return r.changes;
}
