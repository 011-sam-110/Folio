import { Router, type Response } from 'express';
import { db, newId, nowIso } from '../db.js';
import { chat, extractJson, AiError } from '../ai/client.js';
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
    const { text: markdown, model } = await chat(improvePrompt(content, typeof instruction === 'string' ? instruction : undefined));
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
    const { text, model } = await chat(summarizePrompt(note.content_text, note.title || 'Untitled'));
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
    const { text, model } = await chat(flashcardsPrompt(note.content_text, note.title || 'Untitled', target));

    let parsed: unknown;
    try {
      parsed = extractJson<unknown>(text);
    } catch (parseErr) {
      throw new AiError('AI returned unparsable flashcards', [
        { model, error: parseErr instanceof Error ? parseErr.message : String(parseErr) },
      ]);
    }
    if (!Array.isArray(parsed)) {
      throw new AiError('AI response was not a flashcard array', [{ model, error: 'not an array' }]);
    }

    const cards = parsed
      .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
      .map(c => ({ question: String(c.question ?? '').trim(), answer: String(c.answer ?? '').trim() }))
      .filter(c => c.question.length > 0 && c.answer.length > 0)
      .slice(0, target);

    if (cards.length === 0) {
      throw new AiError('AI returned no valid flashcards', [{ model, error: 'empty after validation' }]);
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
    ? (db.prepare('SELECT COUNT(*) as c FROM notes WHERE notebook_id = ? AND archived = 0').get(nbId) as { c: number }).c
    : (db.prepare('SELECT COUNT(*) as c FROM notes WHERE archived = 0').get() as { c: number }).c;

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
      WHERE notes_fts MATCH ? AND n.archived = 0 ${nbId ? 'AND n.notebook_id = ?' : ''}
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
      WHERE archived = 0 ${nbId ? 'AND notebook_id = ?' : ''}
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
    const { text } = await chat(titlePrompt(note.content_text));
    const title = cleanTitle(text) || note.title || 'Untitled';
    res.json({ title });
  } catch (e) {
    sendAiError(res, e);
  }
});

export default router;
