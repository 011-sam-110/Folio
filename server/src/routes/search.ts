import { Router } from 'express';
import { db } from '../db.js';
import { noteLite, notebookLite, type NoteRow } from '../lib/serialize.js';

const router = Router();

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, c => `\\${c}`);
}

/**
 * Keeps only letters/digits/underscore/apostrophe/hyphen, then drops the result
 * entirely unless at least one letter or digit survived — this is what stops a
 * stray "-", "'", or punctuation soup from turning into an empty (or
 * quote-breaking) FTS5 token.
 */
function cleanToken(raw: string): string {
  const cleaned = raw.normalize('NFKC').replace(/[^\p{L}\p{N}_'-]+/gu, '');
  return /[\p{L}\p{N}]/u.test(cleaned) ? cleaned : '';
}

export interface ParsedSearch {
  terms: string[];
  phrases: string[];
  excluded: string[];
  tag: string | null;
  notebook: string | null;
}

/**
 * Operator grammar (docs/API.md "Search operators"), parsed in this order:
 *   1. "exact phrase"   → FTS phrase query
 *   2. -word             → excluded term (FTS NOT)
 *   3. tag:name           → note_tags filter (first one wins; case-sensitive, matches
 *      the exact-match semantics GET /api/notes?tag= already uses)
 *   4. notebook:name       → notebooks.name filter (case-insensitive prefix)
 *   5. everything left over → bareword terms, AND'd, trailing `*` prefix on the last
 * Never throws: worst case everything sanitizes away to empty, which the caller
 * turns into an empty result set rather than a 500.
 */
export function parseSearchQuery(raw: string): ParsedSearch {
  let rest = typeof raw === 'string' ? raw : '';

  const phrases: string[] = [];
  rest = rest.replace(/"([^"]*)"/g, (_m, inner: string) => {
    const words = inner.split(/\s+/).map(cleanToken).filter(Boolean);
    if (words.length) phrases.push(words.join(' '));
    return ' ';
  });

  const terms: string[] = [];
  const excluded: string[] = [];
  let tag: string | null = null;
  let notebook: string | null = null;

  for (const tok of rest.split(/\s+/).filter(Boolean)) {
    const lower = tok.toLowerCase();
    if (lower.startsWith('tag:')) {
      const v = cleanToken(tok.slice(4));
      if (v && tag === null) tag = v;
      continue;
    }
    if (lower.startsWith('notebook:')) {
      // Notebook names can contain spaces/punctuation ("Data Structures") that a
      // single whitespace-delimited token can never carry, so this is used as a
      // parameterized LIKE prefix rather than run through the alnum-only cleanToken.
      const v = tok.slice('notebook:'.length).trim();
      if (v && notebook === null) notebook = v;
      continue;
    }
    if (tok.startsWith('-') && tok.length > 1) {
      const v = cleanToken(tok.slice(1));
      if (v) excluded.push(v);
      continue;
    }
    const v = cleanToken(tok);
    if (v) terms.push(v);
  }

  return { terms, phrases, excluded, tag, notebook };
}

/** Builds the FTS5 MATCH string, or null when there's no positive text criteria
 *  (tag:/notebook:-only queries fall through to a non-FTS branch in the route). */
function ftsMatchString(parsed: ParsedSearch): string | null {
  const phraseParts = parsed.phrases.map(p => `"${p}"`);
  const termParts = parsed.terms.map((t, i) => (i === parsed.terms.length - 1 ? `"${t}"*` : `"${t}"`));
  const include = [...phraseParts, ...termParts];
  if (!include.length) return null;
  const excludeParts = parsed.excluded.map(e => `NOT "${e}"`);
  return [...include, ...excludeParts].join(' ');
}

router.get('/', (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const parsed = parseSearchQuery(q);
  const match = ftsMatchString(parsed);

  try {
    if (match) {
      // Text criteria present — rank with FTS5 bm25, tag/notebook become extra joins.
      const joins: string[] = [];
      const joinParams: unknown[] = [];
      if (parsed.tag) {
        joins.push('JOIN note_tags nt ON nt.note_id = n.id AND nt.tag = ?');
        joinParams.push(parsed.tag);
      }
      if (parsed.notebook) {
        joins.push("JOIN notebooks nb ON nb.id = n.notebook_id AND lower(nb.name) LIKE lower(?) ESCAPE '\\'");
        joinParams.push(`${escapeLike(parsed.notebook)}%`);
      }

      const rows = db
        .prepare(
          `SELECT n.*, bm25(notes_fts) as rank, snippet(notes_fts, 1, '<mark>', '</mark>', '…', 12) as snip
           FROM notes_fts
           JOIN notes n ON n.rowid = notes_fts.rowid
           ${joins.join(' ')}
           WHERE notes_fts MATCH ? AND n.archived = 0 AND n.deleted_at IS NULL
           ORDER BY rank ASC
           LIMIT ?`,
        )
        .all(...joinParams, match, limit) as Array<NoteRow & { rank: number; snip: string }>;

      return res.json({
        results: rows.map(r => ({ note: noteLite(r), snippetHtml: r.snip, score: r.rank })),
        parsed,
      });
    }

    if (parsed.tag || parsed.notebook) {
      // Pure tag:/notebook: browsing (no text term) — e.g. the Tags page's
      // "search notes →" link (`/search?q=tag:x`). No FTS row to rank by, so
      // fall back to a plain notes lookup ordered by recency.
      const conditions = ['n.archived = 0', 'n.deleted_at IS NULL'];
      const params: unknown[] = [];
      let join = '';
      if (parsed.tag) {
        join += ' JOIN note_tags nt ON nt.note_id = n.id AND nt.tag = ?';
        params.push(parsed.tag);
      }
      if (parsed.notebook) {
        join += " JOIN notebooks nb ON nb.id = n.notebook_id AND lower(nb.name) LIKE lower(?) ESCAPE '\\'";
        params.push(`${escapeLike(parsed.notebook)}%`);
      }

      const rows = db
        .prepare(`SELECT n.* FROM notes n ${join} WHERE ${conditions.join(' AND ')} ORDER BY n.updated_at DESC LIMIT ?`)
        .all(...params, limit) as NoteRow[];

      return res.json({
        results: rows.map(r => {
          const lite = noteLite(r);
          return { note: lite, snippetHtml: lite.snippet, score: 0 };
        }),
        parsed,
      });
    }

    // Nothing usable survived parsing (empty q, or e.g. only punctuation/only a
    // bare "-exclude" with no positive criteria) — never 500, just no results.
    res.json({ results: [], parsed });
  } catch {
    // A hostile/malformed query should never 500 the request.
    res.json({ results: [], parsed });
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
       WHERE archived = 0 AND deleted_at IS NULL AND lower(title) LIKE lower(?) ESCAPE '\\'
       ORDER BY prefix_rank ASC, updated_at DESC
       LIMIT ?`,
    )
    .all(`${escaped}%`, `%${escaped}%`, limit) as Array<{ id: string; title: string; notebook_id: string; updated_at: string }>;

  res.json({ results: rows.map(r => ({ id: r.id, title: r.title, notebook: notebookLite(r.notebook_id), updatedAt: r.updated_at })) });
});

export default router;
