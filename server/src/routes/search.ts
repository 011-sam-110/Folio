import { Router } from 'express';
import { db } from '../db.js';
import { noteLite, notebookLite, type NoteRow } from '../lib/serialize.js';

const router = Router();

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, c => `\\${c}`);
}

/**
 * Turn arbitrary user input into a safe FTS5 MATCH string: every token is wrapped in
 * double quotes (so FTS operators like AND/OR/NOT/NEAR and stray punctuation can never
 * be interpreted as syntax), and the last token gets a trailing `*` for prefix
 * search-as-you-type. Returns null when there's nothing usable to search for.
 */
function sanitizeFtsQuery(raw: string): string | null {
  const cleaned = raw.normalize('NFKC').replace(/"/g, ' ');
  const tokens = cleaned
    .split(/\s+/)
    .map(t => t.replace(/[^\p{L}\p{N}_'-]+/gu, ''))
    .filter(Boolean);
  if (!tokens.length) return null;
  return tokens.map((t, i) => (i === tokens.length - 1 ? `"${t}"*` : `"${t}"`)).join(' ');
}

router.get('/', (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const match = sanitizeFtsQuery(q);
  if (!match) return res.json({ results: [] });

  try {
    const rows = db
      .prepare(
        `SELECT n.*, bm25(notes_fts) as rank, snippet(notes_fts, 1, '<mark>', '</mark>', '…', 12) as snip
         FROM notes_fts
         JOIN notes n ON n.rowid = notes_fts.rowid
         WHERE notes_fts MATCH ? AND n.archived = 0
         ORDER BY rank ASC
         LIMIT ?`,
      )
      .all(match, limit) as Array<NoteRow & { rank: number; snip: string }>;

    res.json({ results: rows.map(r => ({ note: noteLite(r), snippetHtml: r.snip, score: r.rank })) });
  } catch {
    // A hostile/malformed query should never 500 the request.
    res.json({ results: [] });
  }
});

router.get('/titles', (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
  if (!q) return res.json({ results: [] });

  const escaped = escapeLike(q);
  const rows = db
    .prepare(
      `SELECT id, title, notebook_id, updated_at,
         CASE WHEN lower(title) LIKE lower(?) ESCAPE '\\' THEN 0 ELSE 1 END as prefix_rank
       FROM notes
       WHERE archived = 0 AND lower(title) LIKE lower(?) ESCAPE '\\'
       ORDER BY prefix_rank ASC, updated_at DESC
       LIMIT ?`,
    )
    .all(`${escaped}%`, `%${escaped}%`, limit) as Array<{ id: string; title: string; notebook_id: string; updated_at: string }>;

  res.json({ results: rows.map(r => ({ id: r.id, title: r.title, notebook: notebookLite(r.notebook_id), updatedAt: r.updated_at })) });
});

export default router;
