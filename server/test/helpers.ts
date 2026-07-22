// Shared test scaffolding for the Postgres/multi-user server.
//
// Two things every DB-touching suite now needs, which the SQLite single-user tests did
// not: a way to reset a *shared* database between runs (there is no per-test .db file to
// delete any more), and a way to make an authenticated caller (every /api router below
// /api/auth sits behind requireAuth, and every query is scoped to the session user).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { Express } from 'express';
import { db, migrate, newId, nowIso, pool } from '../src/db.js';
import { createSession, COOKIE_NAME } from '../src/auth/session.js';

/**
 * Drop every table and re-apply schema.sql.
 *
 * `DROP SCHEMA public CASCADE` rather than a DELETE sweep: it also clears the generated
 * `fts` column, indexes and identity sequences, so a suite cannot inherit state (or a
 * stale column set) from an earlier run against a different schema version.
 *
 * migrate() memoises its promise in db.ts, so the module-level cache has to be cleared
 * too - otherwise the re-apply would be skipped and every table would be missing.
 */
export async function resetDatabase(): Promise<void> {
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  // schema.sql is applied directly rather than via migrate(): migrate() memoises its
  // promise for the life of the process, so after a reset it would resolve instantly
  // without recreating anything. Calling it afterwards just primes that memo - the
  // script is idempotent (CREATE TABLE IF NOT EXISTS throughout), so the app.ts
  // request-time gate then finds the schema already in place.
  await pool.query(readSchema());
  await migrate();
}

function readSchema(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return fs.readFileSync(path.join(here, '..', 'src', 'schema.sql'), 'utf8');
}

/**
 * Wipe all row data but keep the schema - the per-test reset.
 *
 * `TRUNCATE users CASCADE` reaches everything: notebooks/notes/attachments/flashcards/
 * sessions/templates all reference users, and note_versions/note_tags/links/comments/
 * canvas_* cascade in turn from notes.
 *
 * Caveat: it therefore also removes the shared built-in templates (user_id NULL), and
 * `seedBuiltinTemplates()` memoises its promise, so it will not put them back. A suite
 * that asserts on built-ins must call `resetDatabase()` in a fresh process or insert
 * them itself - see templates.test.ts.
 */
export async function resetData(): Promise<void> {
  await pool.query('TRUNCATE users CASCADE');
}

export interface TestUser {
  id: string;
  email: string;
  /** supertest agent carrying this user's session cookie. */
  agent: ReturnType<typeof request.agent>;
}

let userSeq = 0;

/**
 * Create a user and return an agent already carrying its session cookie.
 *
 * The row and session are inserted directly rather than by POSTing /api/auth/signup:
 * signup runs scrypt at OWASP parameters (N=2^17), which is ~150ms a call by design and
 * would dominate the runtime of suites that make a user per test. Tests that are about
 * signup itself should still go through the real endpoint.
 */
export async function makeUser(app: Express, email?: string): Promise<TestUser> {
  const id = newId();
  const addr = email ?? `test-${++userSeq}-${id}@example.com`;
  await db
    .prepare(
      `INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, addr, 'Test user', 'x'.repeat(128), 'y'.repeat(32), nowIso());

  const token = await createSession(id);
  const agent = request.agent(app);
  // The cookie is normally set by the login response; set it directly since we skipped
  // the login round-trip. Same name/value the server would have issued.
  agent.jar.setCookie(`${COOKIE_NAME}=${token}; Path=/`);
  return { id, email: addr, agent };
}

/** A starter notebook owned by `userId`, inserted directly. */
export async function insertNotebook(
  userId: string,
  overrides: Partial<{ name: string; emoji: string; color: string; position: number; archived: number }> = {},
): Promise<string> {
  const id = newId();
  await db
    .prepare(
      `INSERT INTO notebooks (id, user_id, name, emoji, color, position, archived, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      userId,
      overrides.name ?? 'Test notebook',
      overrides.emoji ?? '📓',
      overrides.color ?? '#4f46e5',
      overrides.position ?? 0,
      overrides.archived ?? 0,
      nowIso(),
    );
  return id;
}

/** A note owned by `userId`, inserted directly. */
export async function insertNote(
  userId: string,
  notebookId: string,
  overrides: Partial<{
    title: string;
    content_text: string;
    content_json: string;
    pinned: number;
    archived: number;
    created_at: string;
    updated_at: string;
    deleted_at: string | null;
  }> = {},
): Promise<string> {
  const id = newId();
  const created = overrides.created_at ?? nowIso();
  await db
    .prepare(
      `INSERT INTO notes (id, user_id, notebook_id, title, content_json, content_text,
                          pinned, archived, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      userId,
      notebookId,
      overrides.title ?? 'Test note',
      overrides.content_json ?? '{"type":"doc","content":[{"type":"paragraph"}]}',
      overrides.content_text ?? 'some content',
      overrides.pinned ?? 0,
      overrides.archived ?? 0,
      overrides.deleted_at ?? null,
      created,
      overrides.updated_at ?? created,
    );
  return id;
}

/** A flashcard owned by `userId`, inserted directly. */
export async function insertCard(
  userId: string,
  noteId: string | null,
  overrides: Partial<{
    question: string;
    answer: string;
    ease: number;
    interval_days: number;
    reps: number;
    lapses: number;
    due_at: string;
    suspended: number;
  }> = {},
): Promise<string> {
  const id = newId();
  await db
    .prepare(
      `INSERT INTO flashcards (id, user_id, note_id, question, answer, ease, interval_days,
                               reps, lapses, due_at, suspended, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      userId,
      noteId,
      overrides.question ?? 'Q?',
      overrides.answer ?? 'A.',
      overrides.ease ?? 2.5,
      overrides.interval_days ?? 0,
      overrides.reps ?? 0,
      overrides.lapses ?? 0,
      overrides.due_at ?? new Date(Date.now() - 5 * 60_000).toISOString(),
      overrides.suspended ?? 0,
      nowIso(),
    );
  return id;
}

/** Close the pool so vitest's worker can exit. */
export async function closeDatabase(): Promise<void> {
  await pool.end();
}
