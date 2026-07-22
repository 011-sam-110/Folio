import { Router, type Response } from 'express';
import { db, tx, newId, nowIso } from '../db.js';
// Auth is mounted once, in app.ts (`app.use('/api/ai', requireAuth, ...)`), so this
// router does not add its own guard — one layer means one place to audit and one session
// lookup per request. `userId(req)` throws if that mount ever loses the guard, so the
// failure mode is a loud 500, never an unscoped query.
import { userId } from '../auth/middleware.js';
import { extractJson, AiError, capForAi } from '../ai/client.js';
import { aiQuotaGate, aiCtx, complete } from '../ai/gate.js';
import { checkQuota } from '../ai/usage.js';
import { clientIp } from '../lib/clientIp.js';
import { checkUserSuppliedUrl } from '../lib/publicHost.js';
import { getKeyHint, setUserKey, deleteUserKey } from '../ai/keys.js';
import { improvePrompt, summarizePrompt, flashcardsPrompt, askPrompt, titlePrompt, cleanTitle, cleanPrompt, gapsPrompt } from '../ai/prompts.js';
import type { NoteRow } from '../lib/serialize.js';

const router = Router();

function sendAiError(res: Response, e: unknown): void {
  if (e instanceof AiError) {
    res.status(502).json({ error: e.message, attempts: e.attempts });
    return;
  }
  throw e;
}

/**
 * Fetch a note the caller is allowed to feed to the model.
 *
 * Ownership is enforced here rather than at each call site: every AI endpoint reaches a
 * note through this helper, so a single missing `user_id` predicate would hand another
 * user's content (and its attachments, via /gaps) straight to the gateway. `uid` must
 * come from `userId(req)` — never from the request body.
 *
 * Someone else's note is reported as "not found" rather than "forbidden", so the
 * endpoints never confirm that a guessed id exists.
 *
 * Trash-aware: no AI endpoint should read (or spend gateway quota on) a soft-deleted note.
 */
async function getNote(noteId: string, uid: string): Promise<NoteRow | undefined> {
  return await db
    .prepare('SELECT * FROM notes WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .get<NoteRow>(noteId, uid);
}

/**
 * Turn free text into `websearch_to_tsquery` input for retrieval-style (any-term) matching.
 *
 * Postgres replaces FTS5's MATCH grammar. `websearch_to_tsquery` parses leniently and
 * cannot raise a syntax error, so the sanitizer is about relevance, not safety: it drops
 * operator-ish punctuation, caps the term count, and quotes each token so a term that
 * happens to be `or` or `-foo` is treated as a literal word rather than as an operator.
 *
 * (Duplicated deliberately — routes/search.ts owns the search-as-you-type sanitizer.)
 */
function sanitizeAskQuery(raw: string): string {
  const tokens = raw
    .normalize('NFKC')
    .replace(/["*^:()]/g, ' ')
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length > 1)
    .slice(0, 10)
    .map(t => `"${t}"`);
  return tokens.join(' OR ');
}

// ---------------------------------------------------------------------------
// Account routes. Registered BEFORE the quota gate on purpose: a user who has
// exhausted their allowance still has to be able to see that they have, and to
// save a key that lifts it. Gating these would lock the door and hide the handle.
// ---------------------------------------------------------------------------

/** GET /api/ai/usage — what the settings screen and the AI menu footer display. */
router.get('/usage', async (req, res) => {
  const uid = userId(req);
  const [verdict, key] = await Promise.all([
    checkQuota(uid, clientIp(req)),
    getKeyHint(uid),
  ]);
  res.json({
    // With a key saved the limits do not apply, so the UI shows "unlimited" rather
    // than a bar that is meaningless to the person reading it.
    usingOwnKey: key.present,
    keyHint: key.hint,
    baseUrl: key.baseUrl,
    user: verdict.user,
    ip: verdict.ip,
    resetAt: verdict.resetAt,
  });
});

/** PUT /api/ai/key { apiKey, baseUrl? } — save a personal provider key. */
router.put('/key', async (req, res) => {
  const uid = userId(req);
  const { apiKey, baseUrl } = (req.body ?? {}) as { apiKey?: unknown; baseUrl?: unknown };

  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    res.status(400).json({ error: 'An API key is required.' });
    return;
  }
  // Bounded so the field cannot be used to push arbitrary blobs into the database.
  // Real provider keys are well under this.
  if (apiKey.length > 512) {
    res.status(400).json({ error: 'That does not look like an API key.' });
    return;
  }

  let cleanBaseUrl: string | null = null;
  if (typeof baseUrl === 'string' && baseUrl.trim()) {
    // The server is what dereferences this, and callOnce echoes part of a non-200 body back
    // to the caller, so an unchecked value here is a readable SSRF. checkUserSuppliedUrl
    // covers scheme, embedded credentials, and private/loopback/link-local targets.
    const verdict = checkUserSuppliedUrl(baseUrl.trim());
    if (!verdict.ok) {
      res.status(400).json({ error: verdict.reason });
      return;
    }
    cleanBaseUrl = new URL(baseUrl.trim()).toString().replace(/\/$/, '');
  }

  await setUserKey(uid, apiKey.trim(), cleanBaseUrl);
  res.json(await getKeyHint(uid));
});

/** DELETE /api/ai/key — go back to the shared pool. */
router.delete('/key', async (req, res) => {
  await deleteUserKey(userId(req));
  res.json({ present: false, hint: '', baseUrl: null });
});

// ---------------------------------------------------------------------------
// Everything below spends AI budget, so everything below is gated. Applied once
// here rather than per handler: a new endpoint added beneath this line is metered
// by default, which is the failure mode we want.
// ---------------------------------------------------------------------------
router.use(aiQuotaGate);

// POST /api/ai/improve { noteId?, text?, instruction? }
router.post('/improve', async (req, res) => {
  const uid = userId(req);
  const { noteId, text, instruction } = (req.body ?? {}) as { noteId?: unknown; text?: unknown; instruction?: unknown };

  let content: string;
  if (typeof noteId === 'string' && noteId) {
    const note = await getNote(noteId, uid);
    if (!note) return res.status(404).json({ error: 'note not found' });
    content = note.content_text;
  } else if (typeof text === 'string' && text.trim()) {
    content = text;
  } else {
    return res.status(400).json({ error: 'noteId or text is required' });
  }

  try {
    const { text: markdown, model } = await complete(aiCtx(req), improvePrompt(capForAi(content), typeof instruction === 'string' ? instruction : undefined));
    res.json({ markdown: markdown.trim(), model });
  } catch (e) {
    sendAiError(res, e);
  }
});

// POST /api/ai/summarize { noteId }
router.post('/summarize', async (req, res) => {
  const uid = userId(req);
  const { noteId } = (req.body ?? {}) as { noteId?: unknown };
  if (typeof noteId !== 'string' || !noteId) return res.status(400).json({ error: 'noteId is required' });
  const note = await getNote(noteId, uid);
  if (!note) return res.status(404).json({ error: 'note not found' });

  try {
    const { text, model } = await complete(aiCtx(req), summarizePrompt(capForAi(note.content_text), note.title || 'Untitled'));
    res.json({ markdown: text.trim(), model });
  } catch (e) {
    sendAiError(res, e);
  }
});

// POST /api/ai/flashcards { noteId, count? }
router.post('/flashcards', async (req, res) => {
  const uid = userId(req);
  const { noteId, count } = (req.body ?? {}) as { noteId?: unknown; count?: unknown };
  if (typeof noteId !== 'string' || !noteId) return res.status(400).json({ error: 'noteId is required' });
  const note = await getNote(noteId, uid);
  if (!note) return res.status(404).json({ error: 'note not found' });

  const requested = Number(count);
  const target = Number.isFinite(requested) && requested > 0 ? Math.min(20, Math.max(1, Math.trunc(requested))) : 8;

  try {
    // chat() already falls back across the model chain on *transport* failures, but a
    // model can return HTTP 200 with malformed/empty JSON. That content-level failure
    // is the dominant flakiness source, so retry the whole generate→parse→validate
    // cycle a few times (each attempt draws a fresh sample at temp 0.4) before giving
    // up, rather than failing the request on a single bad completion.
    const MAX_ATTEMPTS = 3;
    const failures: Array<{ model: string; error: string }> = [];
    let cards: Array<{ question: string; answer: string }> | null = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS && !cards; attempt++) {
      const { text, model } = await complete(aiCtx(req), flashcardsPrompt(capForAi(note.content_text), note.title || 'Untitled', target));

      let parsed: unknown;
      try {
        parsed = extractJson<unknown>(text);
      } catch (parseErr) {
        failures.push({ model, error: `unparsable: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}` });
        continue;
      }
      if (!Array.isArray(parsed)) {
        failures.push({ model, error: 'not an array' });
        continue;
      }

      const candidate = parsed
        .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
        .map(c => ({ question: String(c.question ?? '').trim(), answer: String(c.answer ?? '').trim() }))
        .filter(c => c.question.length > 0 && c.answer.length > 0)
        .slice(0, target);

      if (candidate.length === 0) {
        failures.push({ model, error: 'empty after validation' });
        continue;
      }
      cards = candidate;
    }

    if (!cards) {
      throw new AiError('AI returned no valid flashcards', failures);
    }

    const now = nowIso();
    const cardSet = cards.map(c => ({ id: newId(), question: c.question, answer: c.answer }));

    // The generated set is written in one transaction: each card is now a separate
    // round trip (the driver is async), so without it a failure part-way through would
    // leave the user with a truncated deck and no error trail. Note the callback uses
    // the scoped `t` — the module-level `db` draws a different pooled connection and
    // would run outside the transaction.
    await tx(async t => {
      const insert = t.prepare(
        'INSERT INTO flashcards (id, user_id, note_id, question, answer, due_at) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (const c of cardSet) {
        // The owner comes from the session, not the request — and `noteId` was proven to
        // belong to `uid` by getNote() above, so card and note can never diverge.
        await insert.run(c.id, uid, noteId, c.question, c.answer, now);
      }
    });

    const inserted = cardSet.map(c => ({
      id: c.id,
      noteId,
      noteTitle: note.title,
      question: c.question,
      answer: c.answer,
      dueAt: now,
      reps: 0,
      suspended: false,
    }));

    res.json({ cards: inserted });
  } catch (e) {
    sendAiError(res, e);
  }
});

// POST /api/ai/ask { question, notebookId? }
router.post('/ask', async (req, res) => {
  const uid = userId(req);
  const { question, notebookId } = (req.body ?? {}) as { question?: unknown; notebookId?: unknown };
  if (typeof question !== 'string' || !question.trim()) return res.status(400).json({ error: 'question is required' });
  const nbId = typeof notebookId === 'string' && notebookId ? notebookId : undefined;

  // notebook_id is never trusted on its own: notes.user_id is denormalised, so filtering
  // on both means another user's notebook id simply matches zero notes and falls through
  // to the empty-scope reply below — it cannot widen the RAG context, and it does not
  // reveal whether that notebook exists.
  const scopeCount = nbId
    ? (
        await db
          .prepare('SELECT COUNT(*) as c FROM notes WHERE user_id = ? AND notebook_id = ? AND archived = 0 AND deleted_at IS NULL')
          .get<{ c: number }>(uid, nbId)
      )?.c ?? 0
    : (
        await db
          .prepare('SELECT COUNT(*) as c FROM notes WHERE user_id = ? AND archived = 0 AND deleted_at IS NULL')
          .get<{ c: number }>(uid)
      )?.c ?? 0;

  if (scopeCount === 0) {
    res.json({
      answer: nbId
        ? "This notebook doesn't have any notes yet — add some notes before asking questions about it."
        : "You don't have any notes yet — add some notes and I'll be able to answer questions from them.",
      sources: [],
      model: '',
    });
    return;
  }

  type Row = { id: string; title: string; content_text: string };
  const matchQuery = sanitizeAskQuery(question);
  let rows: Row[] = [];

  if (matchQuery) {
    // FTS5's virtual table is gone: notes.fts is a generated tsvector column (schema.sql),
    // so the match is a plain predicate on notes — no rowid join, which Postgres has no
    // equivalent for — and ts_rank replaces bm25(). websearch_to_tsquery cannot throw on
    // malformed input, so the old catch-and-fall-back guard around this query is gone; a
    // real database error should now surface rather than be silently downgraded to a
    // recency listing. Zero matches still fall through to the fallback below.
    const sql = `
      SELECT id, title, content_text
      FROM notes
      WHERE user_id = ?
        AND fts @@ websearch_to_tsquery('english', ?)
        AND archived = 0 AND deleted_at IS NULL ${nbId ? 'AND notebook_id = ?' : ''}
      ORDER BY ts_rank(fts, websearch_to_tsquery('english', ?)) DESC
      LIMIT 6
    `;
    // The query text is bound twice (match + rank); placeholders are numbered in textual
    // order, so the notebook filter sits between the two copies.
    rows = nbId
      ? await db.prepare(sql).all<Row>(uid, matchQuery, nbId, matchQuery)
      : await db.prepare(sql).all<Row>(uid, matchQuery, matchQuery);
  }

  if (rows.length === 0) {
    const sql = `
      SELECT id, title, content_text FROM notes
      WHERE user_id = ? AND archived = 0 AND deleted_at IS NULL ${nbId ? 'AND notebook_id = ?' : ''}
      ORDER BY updated_at DESC LIMIT 6
    `;
    rows = nbId ? await db.prepare(sql).all<Row>(uid, nbId) : await db.prepare(sql).all<Row>(uid);
  }

  const contextNotes = rows.map(r => ({ title: r.title || 'Untitled', text: r.content_text.slice(0, 2500) }));

  try {
    const { text, model } = await complete(aiCtx(req), askPrompt(question, contextNotes));
    res.json({ answer: text.trim(), sources: rows.map(r => ({ id: r.id, title: r.title || 'Untitled' })), model });
  } catch (e) {
    sendAiError(res, e);
  }
});

// POST /api/ai/clean { noteId } — formatting-only beautification: structure improves,
// wording stays. The client previews + applies; the server never writes the note.
router.post('/clean', async (req, res) => {
  const uid = userId(req);
  const { noteId } = (req.body ?? {}) as { noteId?: unknown };
  if (typeof noteId !== 'string' || !noteId) return res.status(400).json({ error: 'noteId is required' });
  const note = await getNote(noteId, uid);
  if (!note) return res.status(404).json({ error: 'note not found' });

  try {
    const { text, model } = await complete(aiCtx(req), cleanPrompt(capForAi(note.content_text)));
    res.json({ markdown: text.trim(), model });
  } catch (e) {
    sendAiError(res, e);
  }
});

// POST /api/ai/gaps { noteId } — study-assistant gap analysis. Compares the note against
// its own uploaded source material (attachments' extracted text: transcripts, slides,
// photos) plus standard topic coverage. NEVER rewrites the note — output is advisory
// markdown the client renders in the Assistant panel.
const GAP_SOURCE_CHARS = 8_000; // per source
router.post('/gaps', async (req, res) => {
  const uid = userId(req);
  const { noteId } = (req.body ?? {}) as { noteId?: unknown };
  if (typeof noteId !== 'string' || !noteId) return res.status(400).json({ error: 'noteId is required' });
  const note = await getNote(noteId, uid);
  if (!note) return res.status(404).json({ error: 'note not found' });

  // getNote() already proved the note belongs to `uid`, but attachments carry their own
  // user_id — filtering on it too keeps the ownership check local to the query that
  // actually reads the text, so this stays correct if the note lookup ever moves.
  const attRows = await db
    .prepare(
      `SELECT original_name, kind, extracted_text FROM attachments
       WHERE note_id = ? AND user_id = ? AND status = 'ready' AND extracted_text IS NOT NULL AND extracted_text != ''
       ORDER BY created_at ASC`,
    )
    .all<{ original_name: string; kind: string; extracted_text: string }>(noteId, uid);
  const sources = attRows.map(a => ({
    name: a.original_name,
    kind: a.kind,
    text: capForAi(a.extracted_text, GAP_SOURCE_CHARS),
  }));

  try {
    const { text, model } = await complete(aiCtx(req), gapsPrompt(note.title || 'Untitled', capForAi(note.content_text, 12_000), sources));
    res.json({
      markdown: text.trim(),
      model,
      sources: sources.map(s => ({ name: s.name, kind: s.kind })),
    });
  } catch (e) {
    sendAiError(res, e);
  }
});

// POST /api/ai/title { noteId }
router.post('/title', async (req, res) => {
  const uid = userId(req);
  const { noteId } = (req.body ?? {}) as { noteId?: unknown };
  if (typeof noteId !== 'string' || !noteId) return res.status(400).json({ error: 'noteId is required' });
  const note = await getNote(noteId, uid);
  if (!note) return res.status(404).json({ error: 'note not found' });

  try {
    const { text } = await complete(aiCtx(req), titlePrompt(capForAi(note.content_text, 8_000)));
    const title = cleanTitle(text) || note.title || 'Untitled';
    res.json({ title });
  } catch (e) {
    sendAiError(res, e);
  }
});

export default router;
