import { db, tx, type Db } from '../db.js';
import type { NoteIdResolver } from './markdown.js';

// [[Title]] or [[Title|Display text]] — titles never contain [ or ].
const WIKILINK_RE = /\[\[([^\[\]|]+)(?:\|[^\[\]]*)?\]\]/g;

/** Extract the distinct wikilink titles referenced in a note's plain-text body. */
export function extractWikilinkTitles(text: string): string[] {
  const titles = new Set<string>();
  if (!text) return [];
  WIKILINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKILINK_RE.exec(text))) {
    const title = m[1].trim();
    if (title) titles.add(title);
  }
  return [...titles];
}

// Title lookup is per-user: idx_notes_title is on (user_id, lower(title)), and scoping
// here is what stops one user's [[Title]] resolving to another user's note of the same
// name. Takes the `Db` to run on so it can be reused inside a transaction (`t`).
const findByTitleStmt = (d: Db) =>
  d.prepare('SELECT id FROM notes WHERE user_id = ? AND lower(title) = lower(?) AND deleted_at IS NULL LIMIT 1');

/** Resolve a wikilink target title to a live note id owned by `uid` (or null). */
export async function resolveNoteIdByTitle(uid: string, title: string): Promise<string | null> {
  const t = title.trim();
  if (!t) return null;
  const row = await findByTitleStmt(db).get<{ id: string }>(uid, t);
  return row?.id ?? null;
}

/**
 * Pre-resolve every `[[title]]` in `text` against `uid`'s notes and return a
 * *synchronous* resolver over that snapshot, for `markdownToTipTap`.
 *
 * markdownToTipTap's signature is contract: it stays synchronous, so it cannot await a
 * Postgres round-trip per wikilink the way it could call better-sqlite3 inline. Resolving
 * the whole set up front in one query preserves the sync callback and is fewer queries
 * than the old per-link lookups.
 */
export async function createTitleResolver(uid: string, text: string): Promise<NoteIdResolver> {
  const titles = extractWikilinkTitles(text);
  const byTitle = new Map<string, string>();
  if (titles.length) {
    const rows = await db
      .prepare(
        `SELECT id, title FROM notes
          WHERE user_id = ? AND deleted_at IS NULL AND lower(title) IN (${titles.map(() => '?').join(', ')})`,
      )
      .all<{ id: string; title: string }>(uid, ...titles.map(t => t.toLowerCase()));
    // First row wins per title, mirroring the old per-title `LIMIT 1` lookup.
    for (const r of rows) {
      const key = r.title.toLowerCase();
      if (!byTitle.has(key)) byTitle.set(key, r.id);
    }
  }
  return (title: string) => byTitle.get(title.trim().toLowerCase()) ?? null;
}

const deleteLinksStmt = (d: Db) => d.prepare('DELETE FROM links WHERE from_note_id = ?');
const insertLinkStmt = (d: Db) =>
  d.prepare('INSERT INTO links (from_note_id, to_note_id) VALUES (?, ?) ON CONFLICT DO NOTHING');

/**
 * Re-derive one note's outgoing links, on the given connection. Split out from
 * `syncLinksForNote` so callers that are already inside a transaction can pass their
 * scoped `t` — using the module-level `db` there would draw a different pooled
 * connection and run outside the transaction.
 */
async function syncLinksForNoteIn(t: Db, uid: string, noteId: string, contentText: string): Promise<void> {
  // `links` carries no user_id, so ownership has to come from the notes on both ends.
  // The to-side is covered by the uid-scoped title lookup below; the from-side is proven
  // here, once, so the DELETE/INSERT can key off note_id alone. Callers already load the
  // note scoped by user, so this is a backstop — but without it a caller passing an
  // unverified id could rewrite another user's link graph.
  const owned = await t.prepare('SELECT 1 FROM notes WHERE id = ? AND user_id = ?').get(noteId, uid);
  if (!owned) return;

  const toIds = new Set<string>();
  for (const title of extractWikilinkTitles(contentText)) {
    const row = await findByTitleStmt(t).get<{ id: string }>(uid, title);
    if (row && row.id !== noteId) toIds.add(row.id);
  }
  await deleteLinksStmt(t).run(noteId);
  for (const toId of toIds) await insertLinkStmt(t).run(noteId, toId);
}

/**
 * Re-derive this note's outgoing links from its current content_text and replace
 * its rows in `links`. Titles resolve case-insensitively within `uid`'s own notes;
 * unresolved/self titles are dropped.
 */
export async function syncLinksForNote(uid: string, noteId: string, contentText: string): Promise<void> {
  await tx(t => syncLinksForNoteIn(t, uid, noteId, contentText));
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, c => `\\${c}`);
}

/** Re-resolve outgoing links for every live note of `uid`'s whose text references `[[title]]`.
 *  Used after undelete so incoming backlinks to the restored note are rebuilt. */
export async function resyncNotesReferencingTitle(uid: string, title: string, exceptNoteId?: string): Promise<void> {
  const trimmed = title.trim();
  if (!trimmed) return;
  const candidates = await db
    .prepare(
      `SELECT id, content_text FROM notes
        WHERE user_id = ? AND deleted_at IS NULL AND lower(content_text) LIKE lower(?) ESCAPE '\\'`,
    )
    .all<{ id: string; content_text: string }>(uid, `%[[${escapeLike(trimmed)}%`);
  for (const c of candidates) {
    if (c.id === exceptNoteId) continue;
    await syncLinksForNote(uid, c.id, c.content_text);
  }
}

/** Walk a TipTap doc, rewriting the `title` (and back-filling `noteId`) of any wikilink
 *  node whose title matches `oldTitle` (case-insensitive). Returns true if anything changed. */
function rewriteWikilinkNodes(node: unknown, oldLower: string, newTitle: string, renamedNoteId: string): boolean {
  if (!node || typeof node !== 'object') return false;
  const n = node as { type?: string; attrs?: Record<string, unknown>; content?: unknown[] };
  let changed = false;
  if ((n.type === 'wikilink' || n.type === 'wikiLink') && n.attrs) {
    const title = String(n.attrs.title ?? '');
    if (title.toLowerCase() === oldLower) {
      n.attrs.title = newTitle;
      n.attrs.noteId = renamedNoteId;
      changed = true;
    }
  }
  if (Array.isArray(n.content)) {
    for (const c of n.content) if (rewriteWikilinkNodes(c, oldLower, newTitle, renamedNoteId)) changed = true;
  }
  return changed;
}

/**
 * When a note is renamed, keep every note that links to it in sync: rewrite their
 * `[[oldTitle]]` / `[[oldTitle|alias]]` references (in both content_text and the
 * wikilink nodes of content_json) to the new title, then re-resolve their links.
 *
 * Behaviour (documented in docs/API.md): rename is link-preserving. Backlinks and the
 * on-screen wikilink text both follow the new title; the referencing notes' updated_at
 * is intentionally NOT bumped so a rename doesn't reorder the recency feed.
 *
 * Only `uid`'s own notes are considered, and only `uid`'s own notes are rewritten.
 */
export async function renameWikilinksToTitle(
  uid: string,
  renamedNoteId: string,
  oldTitle: string,
  newTitle: string,
): Promise<number> {
  const oldTrim = oldTitle.trim();
  const newTrim = newTitle.trim();
  if (!oldTrim || !newTrim || oldTrim.toLowerCase() === newTrim.toLowerCase()) return 0;

  // `renamedNoteId` gets stamped into other notes' wikilink attrs below, so confirm the
  // caller owns it before it can be written anywhere. Fail closed (nothing renamed).
  const renamed = await db
    .prepare('SELECT 1 FROM notes WHERE id = ? AND user_id = ?')
    .get(renamedNoteId, uid);
  if (!renamed) return 0;

  const oldLower = oldTrim.toLowerCase();
  // Candidate set: any of this user's live notes whose plain text still mentions
  // [[oldTitle...  (broad pre-filter; the precise match happens per-node below).
  const candidates = await db
    .prepare(
      `SELECT id, content_json, content_text FROM notes
        WHERE user_id = ? AND id != ? AND deleted_at IS NULL AND lower(content_text) LIKE lower(?) ESCAPE '\\'`,
    )
    .all<{ id: string; content_json: string; content_text: string }>(
      uid,
      renamedNoteId,
      `%[[${escapeLike(oldTrim)}%`,
    );

  // content_text replacer: [[oldTitle]] and [[oldTitle|alias]] (case-insensitive on the title part).
  const textRe = new RegExp(`\\[\\[${escapeRegex(oldTrim)}((?:\\|[^\\[\\]]*)?)\\]\\]`, 'gi');

  let updated = 0;
  await tx(async (t) => {
    // Everything in here runs on `t`; the module-level `db` would be a different pooled
    // connection and would escape the transaction.
    const update = t.prepare('UPDATE notes SET content_json = ?, content_text = ? WHERE id = ? AND user_id = ?');
    for (const c of candidates) {
      let doc: unknown;
      try {
        doc = JSON.parse(c.content_json);
      } catch {
        continue;
      }
      const jsonChanged = rewriteWikilinkNodes(doc, oldLower, newTrim, renamedNoteId);
      const newText = c.content_text.replace(textRe, (_m, alias: string) => `[[${newTrim}${alias}]]`);
      const textChanged = newText !== c.content_text;
      if (jsonChanged || textChanged) {
        await update.run(JSON.stringify(doc), newText, c.id, uid);
        await syncLinksForNoteIn(t, uid, c.id, newText);
        updated++;
      }
    }
  });
  return updated;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
