import { Router } from 'express';
import { db } from '../db.js';
import { userId } from '../auth/middleware.js';
import { noteLite, notebookLite, type NoteRow } from '../lib/serialize.js';

const router = Router();

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, c => `\\${c}`);
}

/**
 * Keeps only letters/digits/underscore/apostrophe/hyphen, then drops the result
 * entirely unless at least one letter or digit survived — this is what stops a
 * stray "-", "'", or punctuation soup from turning into an empty (or
 * quote-breaking) search token.
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
 *   1. "exact phrase"   → phrase query (adjacent words only)
 *   2. -word             → excluded term (NOT)
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

/** A tsquery expression plus the parameters it consumes, in textual order. */
interface TsQueryExpr {
  sql: string;
  params: string[];
}

/**
 * Build the Postgres tsquery for the parsed query, or null when there is no
 * positive text criteria (tag:/notebook:-only queries fall through to a non-ranked
 * branch in the route, and a bare `-exclude` still yields nothing).
 *
 * Two generators are combined because neither covers the old FTS5 grammar alone:
 *
 *  - `websearch_to_tsquery` handles phrases ("a b" → a <-> b, i.e. adjacency, not
 *    mere co-occurrence) and exclusions (-x → !x) directly, and never raises on
 *    malformed input.
 *  - It has no prefix syntax, so the trailing `*` on the final bareword — documented
 *    in docs/API.md, and what lets the debounced quick switcher match while the user
 *    is still mid-word — is expressed as a separate `to_tsquery('word':*)` conjunct.
 *    The final term is therefore emitted ONLY as the prefix conjunct, never also as
 *    an exact one, or the exact half would veto every prefix-only hit.
 *
 * Every bareword is emitted double-quoted so websearch_to_tsquery reads it as a
 * literal one-word phrase: unquoted, a term of "or" is parsed as the OR operator
 * and would silently loosen an AND query. Exclusions stay unquoted (cleanToken
 * guarantees a single space-free word) because `-` only negates a bare token.
 */
function buildTsQuery(parsed: ParsedSearch): TsQueryExpr | null {
  if (!parsed.phrases.length && !parsed.terms.length) return null;

  const prefixTerm = parsed.terms.length ? parsed.terms[parsed.terms.length - 1] : null;
  const exactTerms = prefixTerm === null ? parsed.terms : parsed.terms.slice(0, -1);

  const websearch = [
    ...parsed.phrases.map(p => `"${p}"`),
    ...exactTerms.map(t => `"${t}"`),
    ...parsed.excluded.map(e => `-${e}`),
  ].join(' ');

  const sql: string[] = [];
  const params: string[] = [];
  if (websearch) {
    sql.push("websearch_to_tsquery('english', ?)");
    params.push(websearch);
  }
  if (prefixTerm) {
    // Single-quote the lexeme (doubling any apostrophe) so the hyphens/apostrophes
    // cleanToken preserves cannot terminate it early: <'e-mail':*>, <'o''brien':*>.
    sql.push("to_tsquery('english', ?)");
    params.push(`'${prefixTerm.replace(/'/g, "''")}':*`);
  }
  return { sql: sql.join(' && '), params };
}

// Mirrors the old snippet(notes_fts, 1, '<mark>', '</mark>', '…', 12): a single
// ~12-word window of content_text with the matched terms wrapped in <mark>.
// (ts_headline only emits FragmentDelimiter *between* fragments, so a one-fragment
// headline has no leading/trailing ellipsis — cosmetic difference from FTS5.)
const HEADLINE_OPTS = 'StartSel=<mark>, StopSel=</mark>, MaxWords=12, MinWords=5, MaxFragments=1';

router.get('/', async (req, res) => {
  const uid = userId(req);
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const parsed = parseSearchQuery(q);
  const tsq = buildTsQuery(parsed);

  try {
    if (tsq) {
      // Text criteria present — rank with ts_rank, tag/notebook become extra joins.
      const joins: string[] = [];
      const joinParams: unknown[] = [];
      if (parsed.tag) {
        // note_tags carries no user_id, so it is scoped by joining through `n` and
        // filtering n.user_id below — the join can only ever reach tags of a note
        // this user owns.
        joins.push('JOIN note_tags nt ON nt.note_id = n.id AND nt.tag = ?');
        joinParams.push(parsed.tag);
      }
      if (parsed.notebook) {
        // nb.user_id is redundant with n.user_id (a note lives in its owner's notebook)
        // but is asserted anyway so a name match can never straddle two accounts.
        joins.push(
          "JOIN notebooks nb ON nb.id = n.notebook_id AND nb.user_id = ? AND lower(nb.name) LIKE lower(?) ESCAPE '\\'",
        );
        joinParams.push(uid, `${escapeLike(parsed.notebook)}%`);
      }

      // The tsquery is inlined three times (headline, rank, filter) rather than
      // hoisted into a CTE so the planner still sees a plain `fts @@ <const query>`
      // predicate and can drive the scan from the GIN index. Params are therefore
      // supplied three times too, in the order the fragments appear in the text.
      // ts_headline is the expensive part, so it runs in an outer SELECT over the
      // already-ranked-and-limited rows instead of over every match.
      const rows = (await db
        .prepare(
          `SELECT m.*, ts_headline('english', m.content_text, ${tsq.sql}, '${HEADLINE_OPTS}') as snip
           FROM (
             SELECT n.*, ts_rank(n.fts, ${tsq.sql}) as rank
             FROM notes n
             ${joins.join(' ')}
             WHERE n.user_id = ?
               AND n.fts @@ (${tsq.sql})
               AND n.archived = 0
               AND n.deleted_at IS NULL
             ORDER BY rank DESC, n.updated_at DESC
             LIMIT ?
           ) m`,
        )
        .all(
          ...tsq.params, // ts_headline
          ...tsq.params, // ts_rank
          ...joinParams,
          uid,
          ...tsq.params, // @@ filter
          limit,
        )) as Array<NoteRow & { rank: number; snip: string }>;

      return res.json({
        results: await Promise.all(
          rows.map(async r => ({ note: await noteLite(r), snippetHtml: r.snip, score: r.rank })),
        ),
        parsed,
      });
    }

    if (parsed.tag || parsed.notebook) {
      // Pure tag:/notebook: browsing (no text term) — e.g. the Tags page's
      // "search notes →" link (`/search?q=tag:x`). There is no relevance score to
      // rank by, so fall back to a plain notes lookup ordered by recency.
      const conditions = ['n.user_id = ?', 'n.archived = 0', 'n.deleted_at IS NULL'];
      const params: unknown[] = [];
      let join = '';
      if (parsed.tag) {
        join += ' JOIN note_tags nt ON nt.note_id = n.id AND nt.tag = ?';
        params.push(parsed.tag);
      }
      if (parsed.notebook) {
        join += " JOIN notebooks nb ON nb.id = n.notebook_id AND nb.user_id = ? AND lower(nb.name) LIKE lower(?) ESCAPE '\\'";
        params.push(uid, `${escapeLike(parsed.notebook)}%`);
      }

      // Join params precede the WHERE params textually, so uid goes after them.
      const rows = (await db
        .prepare(`SELECT n.* FROM notes n ${join} WHERE ${conditions.join(' AND ')} ORDER BY n.updated_at DESC LIMIT ?`)
        .all(...params, uid, limit)) as NoteRow[];

      return res.json({
        results: await Promise.all(
          rows.map(async r => {
            const lite = await noteLite(r);
            return { note: lite, snippetHtml: lite.snippet, score: 0 };
          }),
        ),
        parsed,
      });
    }

    // Nothing usable survived parsing (empty q, or e.g. only punctuation/only a
    // bare "-exclude" with no positive criteria) — never 500, just no results.
    res.json({ results: [], parsed });
  } catch {
    // A hostile/malformed query should never 500 the request. This also absorbs the
    // one input Postgres can still reject: a prefix lexeme that normalizes to nothing.
    res.json({ results: [], parsed });
  }
});

router.get('/titles', async (req, res) => {
  const uid = userId(req);
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
  if (!q) return res.json({ results: [] });

  const escaped = escapeLike(q);
  const rows = (await db
    .prepare(
      `SELECT id, title, notebook_id, updated_at,
         CASE WHEN lower(title) LIKE lower(?) ESCAPE '\\' THEN 0 ELSE 1 END as prefix_rank
       FROM notes
       WHERE user_id = ? AND archived = 0 AND deleted_at IS NULL AND lower(title) LIKE lower(?) ESCAPE '\\'
       ORDER BY prefix_rank ASC, updated_at DESC
       LIMIT ?`,
    )
    .all(`${escaped}%`, uid, `%${escaped}%`, limit)) as Array<{
    id: string;
    title: string;
    notebook_id: string;
    updated_at: string;
  }>;

  res.json({
    results: await Promise.all(
      rows.map(async r => ({
        id: r.id,
        title: r.title,
        notebook: await notebookLite(r.notebook_id, uid),
        updatedAt: r.updated_at,
      })),
    ),
  });
});

export default router;
