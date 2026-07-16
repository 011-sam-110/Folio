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

const findByTitleStmt = () => db.prepare('SELECT id FROM notes WHERE lower(title) = lower(?) LIMIT 1');
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
