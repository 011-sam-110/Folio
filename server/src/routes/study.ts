import { Router } from 'express';
import { db, nowIso } from '../db.js';

const router = Router();

interface FlashcardRow {
  id: string;
  note_id: string | null;
  question: string;
  answer: string;
  ease: number;
  interval_days: number;
  reps: number;
  lapses: number;
  due_at: string;
  suspended: number;
  created_at: string;
  note_title?: string | null;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function flashcardDto(row: FlashcardRow) {
  return {
    id: row.id,
    noteId: row.note_id,
    noteTitle: row.note_title ?? undefined,
    question: row.question,
    answer: row.answer,
    dueAt: row.due_at,
    reps: row.reps,
    suspended: Boolean(row.suspended),
  };
}

const withNoteTitleSql = `
  SELECT f.*, n.title as note_title
  FROM flashcards f
  LEFT JOIN notes n ON n.id = f.note_id
`;

function getCardWithTitle(id: string): FlashcardRow | undefined {
  return db.prepare(`${withNoteTitleSql} WHERE f.id = ?`).get(id) as FlashcardRow | undefined;
}

// GET /api/study/queue?limit=20
router.get('/queue', (req, res) => {
  const limit = clampInt(req.query.limit, 20, 1, 100);
  const now = nowIso();

  const cards = db
    .prepare(`${withNoteTitleSql} WHERE f.suspended = 0 AND f.due_at <= ? ORDER BY f.due_at ASC LIMIT ?`)
    .all(now, limit) as FlashcardRow[];

  const due = (db.prepare('SELECT COUNT(*) as c FROM flashcards WHERE suspended = 0 AND due_at <= ?').get(now) as { c: number }).c;
  const total = (db.prepare('SELECT COUNT(*) as c FROM flashcards').get() as { c: number }).c;

  res.json({ cards: cards.map(flashcardDto), due, total });
});

type Rating = 'again' | 'hard' | 'good' | 'easy';
const RATINGS: Rating[] = ['again', 'hard', 'good', 'easy'];
const MIN_EASE = 1.3;

// POST /api/study/review { cardId, rating }
router.post('/review', (req, res) => {
  const { cardId, rating } = (req.body ?? {}) as { cardId?: unknown; rating?: unknown };
  if (typeof cardId !== 'string' || !cardId) return res.status(400).json({ error: 'cardId is required' });
  if (typeof rating !== 'string' || !RATINGS.includes(rating as Rating)) {
    return res.status(400).json({ error: `rating must be one of: ${RATINGS.join(', ')}` });
  }

  const row = db.prepare('SELECT * FROM flashcards WHERE id = ?').get(cardId) as FlashcardRow | undefined;
  if (!row) return res.status(404).json({ error: 'card not found' });

  let ease = row.ease;
  let interval = row.interval_days;
  let reps = row.reps;
  let lapses = row.lapses;
  const now = Date.now();
  let dueAt: string;

  switch (rating as Rating) {
    case 'again': {
      reps = 0;
      interval = 0;
      ease = Math.max(MIN_EASE, ease - 0.2);
      lapses += 1;
      dueAt = new Date(now + 60_000).toISOString();
      break;
    }
    case 'hard': {
      interval = interval * 1.2;
      ease = Math.max(MIN_EASE, ease - 0.15);
      dueAt = new Date(now + interval * 86_400_000).toISOString();
      break;
    }
    case 'good': {
      reps = reps + 1;
      interval = reps === 1 ? 1 : interval * ease;
      dueAt = new Date(now + interval * 86_400_000).toISOString();
      break;
    }
    case 'easy': {
      const bumped = ease + 0.15;
      interval = interval * bumped * 1.3;
      ease = bumped;
      dueAt = new Date(now + interval * 86_400_000).toISOString();
      break;
    }
  }

  db.prepare('UPDATE flashcards SET ease = ?, interval_days = ?, reps = ?, lapses = ?, due_at = ? WHERE id = ?').run(
    ease,
    interval,
    reps,
    lapses,
    dueAt,
    cardId,
  );
  db.prepare('INSERT INTO review_log (card_id, rating) VALUES (?, ?)').run(cardId, rating);

  const updated = getCardWithTitle(cardId)!;
  res.json({ card: flashcardDto(updated), nextDueAt: dueAt });
});

// GET /api/study/stats
router.get('/stats', (_req, res) => {
  const now = nowIso();
  const due = (db.prepare('SELECT COUNT(*) as c FROM flashcards WHERE suspended = 0 AND due_at <= ?').get(now) as { c: number }).c;
  const total = (db.prepare('SELECT COUNT(*) as c FROM flashcards').get() as { c: number }).c;
  const reviewedToday = (
    db.prepare("SELECT COUNT(*) as c FROM review_log WHERE date(reviewed_at) = date('now')").get() as { c: number }
  ).c;

  const byNote = db
    .prepare(
      `SELECT f.note_id as noteId, n.title as noteTitle,
         COUNT(*) as total,
         SUM(CASE WHEN f.suspended = 0 AND f.due_at <= ? THEN 1 ELSE 0 END) as due
       FROM flashcards f
       LEFT JOIN notes n ON n.id = f.note_id
       WHERE f.note_id IS NOT NULL
       GROUP BY f.note_id
       ORDER BY n.title ASC`,
    )
    .all(now) as Array<{ noteId: string; noteTitle: string | null; total: number; due: number }>;

  res.json({
    due,
    total,
    reviewedToday,
    byNote: byNote.map(r => ({ noteId: r.noteId, noteTitle: r.noteTitle ?? 'Untitled', total: r.total, due: r.due })),
  });
});

// PATCH /api/study/cards/:id { question?, answer?, suspended? }
router.patch('/cards/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM flashcards WHERE id = ?').get(req.params.id) as FlashcardRow | undefined;
  if (!existing) return res.status(404).json({ error: 'card not found' });

  const body = (req.body ?? {}) as { question?: unknown; answer?: unknown; suspended?: unknown };
  const question = typeof body.question === 'string' && body.question.trim() ? body.question.trim() : existing.question;
  const answer = typeof body.answer === 'string' && body.answer.trim() ? body.answer.trim() : existing.answer;
  const suspended = typeof body.suspended === 'boolean' ? (body.suspended ? 1 : 0) : existing.suspended;

  db.prepare('UPDATE flashcards SET question = ?, answer = ?, suspended = ? WHERE id = ?').run(question, answer, suspended, req.params.id);

  res.json({ card: flashcardDto(getCardWithTitle(req.params.id)!) });
});

// DELETE /api/study/cards/:id
router.delete('/cards/:id', (req, res) => {
  const result = db.prepare('DELETE FROM flashcards WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'card not found' });
  res.json({ ok: true });
});

export default router;
