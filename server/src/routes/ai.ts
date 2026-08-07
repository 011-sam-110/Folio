import { Router, type Response } from 'express';
import { db, tx, newId, nowIso } from '../db.js';
// Auth is mounted once, in app.ts (`app.use('/api/ai', requireAuth, ...)`), so this
// router does not add its own guard - one layer means one place to audit and one session
// lookup per request. `userId(req)` throws if that mount ever loses the guard, so the
// failure mode is a loud 500, never an unscoped query.
import { userId } from '../auth/middleware.js';
import { extractJson, AiError, capForAi, aiHealth, userKeyCreds, sharedPoolCreds, forgetAiHealth } from '../ai/client.js';
import { aiQuotaGate, aiCtx, complete } from '../ai/gate.js';
import { checkQuota } from '../ai/usage.js';
import { clientIp } from '../lib/clientIp.js';
import { checkUserSuppliedUrl } from '../lib/publicHost.js';
import { getKeyHint, getUserKey, setUserKey, deleteUserKey } from '../ai/keys.js';
import { improvePrompt, summarizePrompt, flashcardsPrompt, askPrompt, titlePrompt, cleanTitle, cleanPrompt, gapsPrompt, reviewFamilyPrompt, gapEditsPrompt } from '../ai/prompts.js';
import { FAMILIES, PRESETS, familyById, checkById } from '../lib/checks.js';
import { validateEdits, type AiEdit } from '../lib/aiEdit.js';
import { blocksOf, blocksForPrompt } from '../lib/noteBlocks.js';
import type { AiContext } from '../ai/gate.js';
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
 * come from `userId(req)` - never from the request body.
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
 * (Duplicated deliberately - routes/search.ts owns the search-as-you-type sanitizer.)
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

/** GET /api/ai/usage - what the settings screen and the AI menu footer display. */
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
    models: key.models,
    user: verdict.user,
    ip: verdict.ip,
    resetAt: verdict.resetAt,
  });
});

/**
 * Model names for a personal key, as a comma-separated string or an array.
 *
 * Bounded on both count and length for the same reason the key is: this is a free-text
 * field that ends up in a database column and then in a request body sent upstream.
 */
const MAX_MODELS = 6;
function parseModels(raw: unknown): { models: string[] } | { error: string } {
  if (raw === undefined || raw === null || raw === '') return { models: [] };
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : null;
  if (!list) return { error: 'Models must be a comma-separated list of model names.' };
  const cleaned = list.map(m => String(m).trim()).filter(Boolean);
  if (cleaned.length > MAX_MODELS) return { error: `Name at most ${MAX_MODELS} models.` };
  if (cleaned.some(m => m.length > 120)) return { error: 'That does not look like a model name.' };
  return { models: cleaned };
}

/**
 * PUT /api/ai/key { apiKey, baseUrl?, models? } - save a personal provider key.
 *
 * Saves, then immediately probes with the credential it just saved and returns the verdict.
 * Saving silently is what made the original report ("I entered a key and AI stayed off")
 * unexplainable from the user's side: nothing in the product ever told them whether the
 * credential worked. The probe spends one call on THEIR key, which is the right budget for
 * checking their key, and it is the only place the app can honestly say "this works".
 */
router.put('/key', async (req, res) => {
  const uid = userId(req);
  const { apiKey, baseUrl, models } = (req.body ?? {}) as { apiKey?: unknown; baseUrl?: unknown; models?: unknown };

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

  const parsed = parseModels(models);
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  // Read before overwriting so the verdict cached against the OUTGOING credential can be
  // dropped; otherwise a user who fixes a bad endpoint keeps being told it is broken.
  const previous = await getUserKey(uid);
  if (previous) forgetAiHealth(userKeyCreds(previous.apiKey, previous.baseUrl, previous.models));

  await setUserKey(uid, apiKey.trim(), cleanBaseUrl, parsed.models);

  const creds = userKeyCreds(apiKey.trim(), cleanBaseUrl, parsed.models);
  // `force` because the point of this probe is to test the credential just entered, not to
  // report a 60-second-old answer about a different one.
  const health = await aiHealth(creds, 'own-key', { force: true });

  res.json({ ...(await getKeyHint(uid)), health });
});

/**
 * GET /api/ai/checks - the review check catalogue and its presets.
 *
 * Served rather than bundled so the web client never holds a second copy that can drift out
 * of sync with the prompts the suggestion route builds from the same constants. A check the
 * picker offers is therefore, by construction, a check the server actually runs, and adding
 * one needs no web deploy.
 *
 * Registered above the quota gate deliberately: this reads a static in-process constant and
 * spends nothing upstream. Behind the gate it would 429 for a user who had exhausted their
 * allowance, hiding the picker from exactly the person who most needs to narrow their run
 * down to one family.
 */
router.get('/checks', (_req, res) => {
  res.json({ families: FAMILIES, presets: PRESETS });
});

/** DELETE /api/ai/key - go back to the shared pool. */
router.delete('/key', async (req, res) => {
  const uid = userId(req);
  const previous = await getUserKey(uid);
  await deleteUserKey(uid);
  if (previous) forgetAiHealth(userKeyCreds(previous.apiKey, previous.baseUrl, previous.models));

  // The user is back on the pool, so tell them what the pool's state is - the settings
  // dialog would otherwise still be showing the verdict for the key they just removed.
  const health = await aiHealth(sharedPoolCreds(), 'shared-pool');
  res.json({ present: false, hint: '', baseUrl: null, models: [], health });
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
    // the scoped `t` - the module-level `db` draws a different pooled connection and
    // would run outside the transaction.
    await tx(async t => {
      const insert = t.prepare(
        'INSERT INTO flashcards (id, user_id, note_id, question, answer, due_at) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (const c of cardSet) {
        // The owner comes from the session, not the request - and `noteId` was proven to
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
  // to the empty-scope reply below - it cannot widen the RAG context, and it does not
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
        ? "This notebook doesn't have any notes yet - add some notes before asking questions about it."
        : "You don't have any notes yet - add some notes and I'll be able to answer questions from them.",
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
    // so the match is a plain predicate on notes - no rowid join, which Postgres has no
    // equivalent for - and ts_rank replaces bm25(). websearch_to_tsquery cannot throw on
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

// POST /api/ai/clean { noteId } - formatting-only beautification: structure improves,
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

// POST /api/ai/gaps { noteId } - study-assistant gap analysis. Compares the note against
// its own uploaded source material (attachments' extracted text: transcripts, slides,
// photos) plus standard topic coverage. NEVER rewrites the note - output is advisory
// markdown the client renders in the Assistant panel.
const GAP_SOURCE_CHARS = 8_000; // per source
router.post('/gaps', async (req, res) => {
  const uid = userId(req);
  const { noteId } = (req.body ?? {}) as { noteId?: unknown };
  if (typeof noteId !== 'string' || !noteId) return res.status(400).json({ error: 'noteId is required' });
  const note = await getNote(noteId, uid);
  if (!note) return res.status(404).json({ error: 'note not found' });

  // getNote() already proved the note belongs to `uid`, but attachments carry their own
  // user_id - filtering on it too keeps the ownership check local to the query that
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

// ---------------------------------------------------------------------------
// Per-change review.
//
// A review route returns `AiEdit[]` rather than a rewritten note: the client renders each as
// a decoration with its own reason and the user approves or denies them one at a time. The
// whole-note routes above (/improve, /clean) stay as they are - they answer a different
// question, and Summarise still wants a single blob of markdown.
// ---------------------------------------------------------------------------

/**
 * How much of the note each review request carries.
 *
 * Lower than AI_MAX_CHARS because this is spent per family: eight families at 24k characters
 * each is 190k characters of input for one button press, and the tail of a long note is the
 * part a model reviews worst anyway.
 */
const REVIEW_NOTE_CHARS = 12_000;
/** Per uploaded source, in the gaps comparison. Several sources share one request. */
const GAP_EDIT_SOURCE_CHARS = 6_000;
/** A rail citation line has to sit on one line next to the reason. */
const MAX_SOURCE_LABEL = 60;

/** The shape both review routes answer with. */
interface ReviewResponse {
  edits: AiEdit[];
  rejected: number;
  /**
   * Which families actually completed. Requested-minus-this is what did NOT run, so the
   * client can say "Grammar could not be checked" instead of silently implying that a family
   * whose request failed found nothing wrong.
   */
  ranFamilies: string[];
}

/** Known family ids from a request body, de-duplicated, in the order the caller asked. */
function parseFamilies(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const value of raw) {
    const id = typeof value === 'string' ? value.trim() : '';
    // Unknown ids are dropped rather than 400-ing the whole run: the catalogue is served to
    // the client, so a stale id is a client that has not reloaded since a check was
    // deprecated, and refusing the other seven families over it helps nobody.
    if (familyById(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * The note, rendered for a review prompt - or the reason it cannot be.
 *
 * Both failure cases are 400s the client shows verbatim, and they are separated because the
 * fixes are different. A note with text but no block ids has simply never been open in the
 * editor since it was created (an import writes `content_json` directly, and `UniqueID`
 * mints the ids client-side), and telling that user "there is nothing to review" would be
 * flatly untrue about a note full of writing.
 */
function noteForReview(note: NoteRow): { doc: string } | { error: string } {
  const blocks = blocksOf(note.content_json);
  if (!blocks.length) {
    return {
      error: note.content_text.trim()
        ? 'Open this note in the editor and let it save once, then try again.'
        : 'There is nothing in this note to review yet.',
    };
  }
  return { doc: capForAi(blocksForPrompt(blocks), REVIEW_NOTE_CHARS) };
}

/**
 * Pull the edits array out of a completion.
 *
 * Throws rather than returning `[]` on a shape it does not recognise. The distinction is the
 * whole point of `ranFamilies`: a family that returned unusable JSON has NOT been checked,
 * and reporting it as a clean pass would be the model's failure quietly presented to the
 * student as reassurance.
 */
function editsPayload(raw: string): unknown {
  const parsed = extractJson<unknown>(raw);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { edits?: unknown }).edits)) {
    return (parsed as { edits: unknown[] }).edits;
  }
  throw new Error('completion contained no edits array');
}

/**
 * Keep only the edits belonging to the family that was actually asked.
 *
 * Each request names one family and is told to ignore everything else, so an edit citing a
 * check from another family is a request that drifted. Letting it through would make
 * `ranFamilies` a lie - Grammar would appear to have been checked because an Accuracy
 * request happened to mention a typo - and it would double-report anything the other
 * family's own request also found.
 */
function scopeToFamily(edits: AiEdit[], familyId: string): { kept: AiEdit[]; dropped: number } {
  const kept = edits.filter(e => checkById(e.checkId)?.family.id === familyId);
  return { kept, dropped: edits.length - kept.length };
}

/**
 * Namespace edit ids by their family.
 *
 * `validateEdits` guarantees ids are unique within one completion, but a run merges eight
 * independent completions and every one of them is happy to call its first edit `e1`. The
 * client keys approve/deny by id, so a collision means approving one card settles another -
 * a wrong edit applied to the note, from a click on a different card.
 */
function namespaceIds(edits: AiEdit[], familyId: string): AiEdit[] {
  return edits.map(e => ({ ...e, id: `${familyId}:${e.id}` }));
}

/**
 * Trim a run to what the shared pool can actually pay for.
 *
 * The quota gate authorises the REQUEST; a review run then spends one call per family behind
 * it, so a user with two calls left could otherwise spend eight. This uses the same
 * `checkQuota` the gate does and charges through the same `complete()` - there is no second
 * counter - it just prices the run the way the run is actually shaped. A user on their own
 * key is not metered at all, so nothing is trimmed for them.
 *
 * Trimming rather than refusing: someone with two calls left asking for four families is
 * better served by two families' worth of review than by a 429, and `ranFamilies` tells the
 * client exactly which two so it can say so.
 */
async function familiesWithinBudget(ctx: AiContext, requested: string[]): Promise<string[]> {
  if (!ctx.shared) return requested;
  const verdict = await checkQuota(ctx.uid, ctx.ip);
  const remaining = Math.min(verdict.user.remaining, verdict.ip.remaining);
  // The gate has already refused a caller with nothing left, so `remaining` is at least 1
  // here; the floor is belt-and-braces against a counter that moved in between.
  return requested.slice(0, Math.max(1, remaining));
}

/**
 * POST /api/ai/suggest { noteId, families } - the review run.
 *
 * One model request per enabled family, issued in parallel. This is the single most
 * important property of the route: six to eight related checks per prompt is inside what a
 * model reads carefully, whereas all 56 in one prompt buys shallow coverage of all 56.
 * Collapsing this into one call would be cheaper and would quietly gut the feature.
 *
 * A family whose request fails does not fail the run. Free-tier gateways rate-limit in
 * bursts, and losing seven families' worth of review because the eighth was throttled is
 * both the common case and the worst possible answer to it.
 */
router.post('/suggest', async (req, res) => {
  const uid = userId(req);
  const { noteId, families } = (req.body ?? {}) as { noteId?: unknown; families?: unknown };
  if (typeof noteId !== 'string' || !noteId) return res.status(400).json({ error: 'noteId is required' });

  const requested = parseFamilies(families);
  if (!requested.length) return res.status(400).json({ error: 'families must name at least one check family' });

  const note = await getNote(noteId, uid);
  if (!note) return res.status(404).json({ error: 'note not found' });

  const prepared = noteForReview(note);
  if ('error' in prepared) return res.status(400).json({ error: prepared.error });

  const ctx = aiCtx(req);
  const toRun = await familiesWithinBudget(ctx, requested);
  const title = note.title || 'Untitled';

  const results = await Promise.all(
    toRun.map(async (familyId) => {
      const family = familyById(familyId)!;
      try {
        const { text } = await complete(ctx, reviewFamilyPrompt(family, title, prepared.doc));
        const { edits, rejected } = validateEdits(editsPayload(text));
        const scoped = scopeToFamily(edits, familyId);
        return { familyId, edits: namespaceIds(scoped.kept, familyId), rejected: rejected + scoped.dropped };
      } catch (err) {
        // Deliberately swallowed per family, and deliberately logged: the run continues, and
        // the caller learns which families are missing from `ranFamilies` rather than from a
        // 502 that would have thrown away the families that worked.
        console.error('[folio] review family failed', familyId, err);
        return null;
      }
    }),
  );

  const body: ReviewResponse = { edits: [], rejected: 0, ranFamilies: [] };
  for (const result of results) {
    if (!result) continue;
    body.edits.push(...result.edits);
    body.rejected += result.rejected;
    body.ranFamilies.push(result.familyId);
  }
  res.json(body);
});

/**
 * POST /api/ai/gaps/edits { noteId } - what the uploads covered and the note did not.
 *
 * Sits alongside POST /api/ai/gaps rather than replacing it. That route answers the
 * Assistant panel with advisory markdown and is still wired to it; this one answers the
 * review rail with approvable edits. Same comparison, two different products, so they are
 * two different routes rather than one route with a mode flag.
 *
 * Every edit this returns is an `insert`, enforced below and not merely requested in the
 * prompt. "This action never rewrites your own wording" is what makes an Approve-all button
 * safe here in a way it is not for /suggest, and a property that only holds when the model
 * cooperates is not a property. A model-returned `replace` is dropped, never converted: an
 * insert built out of a rewrite would put the model's phrasing into the note under a promise
 * that it never would.
 */
router.post('/gaps/edits', async (req, res) => {
  const uid = userId(req);
  const { noteId } = (req.body ?? {}) as { noteId?: unknown };
  if (typeof noteId !== 'string' || !noteId) return res.status(400).json({ error: 'noteId is required' });
  const note = await getNote(noteId, uid);
  if (!note) return res.status(404).json({ error: 'note not found' });

  // Same read as /gaps: the extracted text of the note's own uploads. `user_id` is checked
  // here as well as on the note, so the ownership predicate sits on the query that actually
  // reads the text.
  const attRows = await db
    .prepare(
      `SELECT id, original_name, kind, extracted_text FROM attachments
       WHERE note_id = ? AND user_id = ? AND status = 'ready' AND extracted_text IS NOT NULL AND extracted_text != ''
       ORDER BY created_at ASC`,
    )
    .all<{ id: string; original_name: string; kind: string; extracted_text: string }>(noteId, uid);

  // No sources means there is no comparison to make, and inventing one would turn this
  // action into "a model guesses what a student forgot" - which is the thing it exists to
  // replace. The message is written to be shown verbatim.
  if (!attRows.length) {
    return res.status(400).json({ error: 'Import slides, a photo or a transcript first.' });
  }

  const prepared = noteForReview(note);
  if ('error' in prepared) return res.status(400).json({ error: prepared.error });

  // Gaps are reported under the missing-content family: its checks are exactly this question
  // ("term used but never defined", "no worked example"), and the rail needs a family to take
  // the edit's severity from.
  const family = familyById('missing-content')!;
  const sources = attRows.map(a => ({
    id: a.id,
    name: a.original_name,
    kind: a.kind,
    text: capForAi(a.extracted_text, GAP_EDIT_SOURCE_CHARS),
  }));
  const allowedSources = new Set(sources.map(s => s.id));

  try {
    const { text, model } = await complete(
      aiCtx(req),
      gapEditsPrompt(family, note.title || 'Untitled', prepared.doc, sources),
    );

    let payload: unknown;
    try {
      payload = editsPayload(text);
    } catch (parseErr) {
      // A content-level failure: HTTP 200 carrying a body we cannot read. Reported as an
      // upstream error rather than as an empty result, because "your note covers everything
      // in the slides" and "the model did not answer" must never look the same to a student
      // deciding whether their notes are complete.
      throw new AiError('AI returned no usable suggestions', [
        { model, error: parseErr instanceof Error ? parseErr.message : String(parseErr) },
      ]);
    }
    const { edits, rejected } = validateEdits(payload);
    const scoped = scopeToFamily(edits, family.id);
    const usable = scoped.kept.filter(
      e =>
        // The insert-only guarantee, and the citation guarantee, enforced rather than asked
        // for. An edit citing an attachment id this request did not supply is either a
        // hallucination or a pointer at someone else's upload; either way the user cannot
        // act on it, and a citation the user cannot act on is worse than none.
        e.op === 'insert' && !!e.source && allowedSources.has(e.source.attachmentId),
    );
    const body: ReviewResponse = {
      edits: namespaceIds(usable, family.id).map(e => ({
        ...e,
        // Trimmed rather than rejected: an over-long label is a citation that is too
        // detailed, which is not a reason to throw away a good suggestion.
        source: { attachmentId: e.source!.attachmentId, label: e.source!.label.slice(0, MAX_SOURCE_LABEL) },
      })),
      rejected: rejected + scoped.dropped + (scoped.kept.length - usable.length),
      // One request, so this is all-or-nothing - and the failure case never reaches here,
      // because a single-call route has nothing to salvage and 502s instead.
      ranFamilies: [family.id],
    };
    res.json(body);
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
