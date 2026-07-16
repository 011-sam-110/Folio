import { db } from '../db.js';

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

const findByTitleStmt = () => db.prepare('SELECT id FROM notes WHERE lower(title) = lower(?) AND deleted_at IS NULL LIMIT 1');

/** Resolve a wikilink target title to a live note id (or null). Used at markdown→TipTap
 *  conversion time so imported/AI notes get real, clickable wikilink nodes. */
export function resolveNoteIdByTitle(title: string): string | null {
  const t = title.trim();
  if (!t) return null;
  const row = findByTitleStmt().get(t) as { id: string } | undefined;
  return row?.id ?? null;
}
const deleteLinksStmt = () => db.prepare('DELETE FROM links WHERE from_note_id = ?');
const insertLinkStmt = () => db.prepare('INSERT OR IGNORE INTO links (from_note_id, to_note_id) VALUES (?, ?)');

/**
 * Re-derive this note's outgoing links from its current content_text and replace
 * its rows in `links`. Titles resolve case-insensitively; unresolved/self titles are dropped.
 */
export function syncLinksForNote(noteId: string, contentText: string): void {
  const titles = extractWikilinkTitles(contentText);
  const toIds = new Set<string>();
  for (const title of titles) {
    const row = findByTitleStmt().get(title) as { id: string } | undefined;
    if (row && row.id !== noteId) toIds.add(row.id);
  }
  const tx = db.transaction(() => {
    deleteLinksStmt().run(noteId);
    for (const toId of toIds) insertLinkStmt().run(noteId, toId);
  });
  tx();
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, c => `\\${c}`);
}

/** Re-resolve outgoing links for every live note whose text references `[[title]]`.
 *  Used after undelete so incoming backlinks to the restored note are rebuilt. */
export function resyncNotesReferencingTitle(title: string, exceptNoteId?: string): void {
  const trimmed = title.trim();
  if (!trimmed) return;
  const candidates = db
    .prepare(`SELECT id, content_text FROM notes WHERE deleted_at IS NULL AND lower(content_text) LIKE lower(?) ESCAPE '\\'`)
    .all(`%[[${escapeLike(trimmed)}%`) as Array<{ id: string; content_text: string }>;
  for (const c of candidates) {
    if (c.id === exceptNoteId) continue;
    syncLinksForNote(c.id, c.content_text);
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
 */
export function renameWikilinksToTitle(renamedNoteId: string, oldTitle: string, newTitle: string): number {
  const oldTrim = oldTitle.trim();
  const newTrim = newTitle.trim();
  if (!oldTrim || !newTrim || oldTrim.toLowerCase() === newTrim.toLowerCase()) return 0;

  const oldLower = oldTrim.toLowerCase();
  // Candidate set: any live note whose plain text still mentions [[oldTitle...  (broad
  // pre-filter; the precise match happens per-node below).
  const candidates = db
    .prepare(`SELECT id, content_json, content_text FROM notes WHERE id != ? AND deleted_at IS NULL AND lower(content_text) LIKE lower(?) ESCAPE '\\'`)
    .all(renamedNoteId, `%[[${escapeLike(oldTrim)}%`) as Array<{ id: string; content_json: string; content_text: string }>;

  // content_text replacer: [[oldTitle]] and [[oldTitle|alias]] (case-insensitive on the title part).
  const textRe = new RegExp(`\\[\\[${escapeRegex(oldTrim)}((?:\\|[^\\[\\]]*)?)\\]\\]`, 'gi');

  const update = db.prepare('UPDATE notes SET content_json = ?, content_text = ? WHERE id = ?');
  let updated = 0;
  const tx = db.transaction(() => {
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
        update.run(JSON.stringify(doc), newText, c.id);
        syncLinksForNote(c.id, newText);
        updated++;
      }
    }
  });
  tx();
  return updated;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
