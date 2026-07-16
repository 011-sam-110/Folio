import { Router, type Response } from 'express';
import { db, newId, nowIso } from '../db.js';
import { chat, extractJson, AiError, capForAi } from '../ai/client.js';
import { improvePrompt, summarizePrompt, flashcardsPrompt, askPrompt, titlePrompt, cleanTitle } from '../ai/prompts.js';
import type { NoteRow } from '../lib/serialize.js';

const router = Router();

function sendAiError(res: Response, e: unknown): void {
  if (e instanceof AiError) {
    res.status(502).json({ error: e.message, attempts: e.attempts });
    return;
  }
  throw e;
}

function getNote(noteId: string): NoteRow | undefined {
  return db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId) as NoteRow | undefined;
}

/** Local FTS5 query sanitizer for retrieval-style matching (duplicated deliberately —
 * routes/search.ts owns the search-as-you-type sanitizer and may not exist yet). */
function sanitizeAskQuery(raw: string): string {
  const tokens = raw
    .normalize('NFKC')
    .replace(/["*^:()]/g, ' ')
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length > 1)
    .slice(0, 10)
    .map(t => `"${t.replace(/"/g, '""')}"`);
  return tokens.join(' OR ');
}

// POST /api/ai/improve { noteId?, text?, instruction? }
router.post('/improve', async (req, res) => {
  const { noteId, text, instruction } = (req.body ?? {}) as { noteId?: unknown; text?: unknown; instruction?: unknown };

  let content: string;
  if (typeof noteId === 'string' && noteId) {
    const note = getNote(noteId);
    if (!note) return res.status(404).json({ error: 'note not found' });
    content = note.content_text;
  } else if (typeof text === 'string' && text.trim()) {
    content = text;
  } else {
    return res.status(400).json({ error: 'noteId or text is required' });
  }

  try {
    const { text: markdown, model } = await chat(improvePrompt(capForAi(content), typeof instruction === 'string' ? instruction : undefined));
    res.json({ markdown: markdown.trim(), model });
  } catch (e) {
    sendAiError(res, e);
  }
});

// POST /api/ai/summarize { noteId }
router.post('/summarize', async (req, res) => {
  const { noteId } = (req.body ?? {}) as { noteId?: unknown };
  if (typeof noteId !== 'string' || !noteId) return res.status(400).json({ error: 'noteId is required' });
  const note = getNote(noteId);
  if (!note) return res.status(404).json({ error: 'note not found' });

  try {
    const { text, model } = await chat(summarizePrompt(capForAi(note.content_text), note.title || 'Untitled'));
    res.json({ markdown: text.trim(), model });
  } catch (e) {
    sendAiError(res, e);
  }
});

// POST /api/ai/flashcards { noteId, count? }
router.post('/flashcards', async (req, res) => {
  const { noteId, count } = (req.body ?? {}) as { noteId?: unknown; count?: unknown };
  if (typeof noteId !== 'string' || !noteId) return res.status(400).json({ error: 'noteId is required' });
  const note = getNote(noteId);
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
      const { text, model } = await chat(flashcardsPrompt(capForAi(note.content_text), note.title || 'Untitled', target));

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
    const insert = db.prepare('INSERT INTO flashcards (id, note_id, question, answer, due_at) VALUES (?, ?, ?, ?, ?)');
    const inserted = cards.map(c => {
      const id = newId();
      insert.run(id, noteId, c.question, c.answer, now);
      return { id, noteId, noteTitle: note.title, question: c.question, answer: c.answer, dueAt: now, reps: 0, suspended: false };
    });

    res.json({ cards: inserted });
  } catch (e) {
    sendAiError(res, e);
  }
});

// POST /api/ai/ask { question, notebookId? }
router.post('/ask', async (req, res) => {
  const { question, notebookId } = (req.body ?? {}) as { question?: unknown; notebookId?: unknown };
  if (typeof question !== 'string' || !question.trim()) return res.status(400).json({ error: 'question is required' });
  const nbId = typeof notebookId === 'string' && notebookId ? notebookId : undefined;

  const scopeCount = nbId
    ? (db.prepare('SELECT COUNT(*) as c FROM notes WHERE notebook_id = ? AND archived = 0 AND deleted_at IS NULL').get(nbId) as { c: number }).c
    : (db.prepare('SELECT COUNT(*) as c FROM notes WHERE archived = 0 AND deleted_at IS NULL').get() as { c: number }).c;

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
    const sql = `
      SELECT n.id as id, n.title as title, n.content_text as content_text
      FROM notes_fts f
      JOIN notes n ON n.rowid = f.rowid
      WHERE notes_fts MATCH ? AND n.archived = 0 AND n.deleted_at IS NULL ${nbId ? 'AND n.notebook_id = ?' : ''}
      ORDER BY bm25(notes_fts)
      LIMIT 6
    `;
    try {
      rows = (nbId ? db.prepare(sql).all(matchQuery, nbId) : db.prepare(sql).all(matchQuery)) as Row[];
    } catch {
      rows = []; // malformed MATCH syntax slipping through the sanitizer — fall back below
    }
  }

  if (rows.length === 0) {
    const sql = `
      SELECT id, title, content_text FROM notes
      WHERE archived = 0 AND deleted_at IS NULL ${nbId ? 'AND notebook_id = ?' : ''}
      ORDER BY updated_at DESC LIMIT 6
    `;
    rows = (nbId ? db.prepare(sql).all(nbId) : db.prepare(sql).all()) as Row[];
  }

  const contextNotes = rows.map(r => ({ title: r.title || 'Untitled', text: r.content_text.slice(0, 2500) }));

  try {
    const { text, model } = await chat(askPrompt(question, contextNotes));
    res.json({ answer: text.trim(), sources: rows.map(r => ({ id: r.id, title: r.title || 'Untitled' })), model });
  } catch (e) {
    sendAiError(res, e);
  }
});

// POST /api/ai/title { noteId }
router.post('/title', async (req, res) => {
  const { noteId } = (req.body ?? {}) as { noteId?: unknown };
  if (typeof noteId !== 'string' || !noteId) return res.status(400).json({ error: 'noteId is required' });
  const note = getNote(noteId);
  if (!note) return res.status(404).json({ error: 'note not found' });

  try {
    const { text } = await chat(titlePrompt(capForAi(note.content_text, 8_000)));
    const title = cleanTitle(text) || note.title || 'Untitled';
    res.json({ title });
  } catch (e) {
    sendAiError(res, e);
  }
});

export default router;
