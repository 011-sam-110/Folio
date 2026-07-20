import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { db } from '../src/db.js';
import {
  resetDatabase,
  resetData,
  makeUser,
  closeDatabase,
  insertNotebook as mkNotebook,
  insertNote as mkNote,
  insertCard as mkCard,
  type TestUser,
} from './helpers.js';

const app = buildApp();

// Flashcards, review_log and the notes they hang off are all owner-scoped now, so every
// fixture belongs to `user` and every request is made as `user`.
let user: TestUser;
let api: TestUser['agent'];

function isoMinutesFromNow(mins: number): string {
  return new Date(Date.now() + mins * 60_000).toISOString();
}

async function insertNotebook(): Promise<string> {
  return mkNotebook(user.id, { name: 'Test notebook' });
}

async function insertNote(notebookId: string, title = 'Test note'): Promise<string> {
  return mkNote(user.id, notebookId, { title, content_text: 'some content' });
}

async function insertCard(
  noteId: string | null,
  opts: Partial<{ question: string; answer: string; ease: number; interval_days: number; reps: number; lapses: number; due_at: string; suspended: number }> = {},
): Promise<string> {
  return mkCard(user.id, noteId, { due_at: isoMinutesFromNow(-5), ...opts });
}

beforeAll(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetData();
  user = await makeUser(app);
  api = user.agent;
});

afterAll(async () => {
  await closeDatabase();
});

describe('GET /api/study/queue', () => {
  it('only returns due, non-suspended cards, and reports due/total counts', async () => {
    const notebookId = await insertNotebook();
    const noteId = await insertNote(notebookId);

    await insertCard(noteId, { due_at: isoMinutesFromNow(-10) }); // due
    await insertCard(noteId, { due_at: isoMinutesFromNow(-1) }); // due
    await insertCard(noteId, { due_at: isoMinutesFromNow(60) }); // not due yet
    await insertCard(noteId, { due_at: isoMinutesFromNow(-10), suspended: 1 }); // suspended, excluded

    const res = await api.get('/api/study/queue');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    expect(res.body.due).toBe(2);
    expect(res.body.cards).toHaveLength(2);
    for (const card of res.body.cards) {
      expect(card.noteId).toBe(noteId);
      expect(card.noteTitle).toBe('Test note');
    }
  });

  it('respects the limit query param', async () => {
    const notebookId = await insertNotebook();
    const noteId = await insertNote(notebookId);
    for (let i = 0; i < 5; i++) await insertCard(noteId, { due_at: isoMinutesFromNow(-1) });

    const res = await api.get('/api/study/queue?limit=2');
    expect(res.status).toBe(200);
    expect(res.body.cards).toHaveLength(2);
    expect(res.body.due).toBe(5);
  });
});

describe('POST /api/study/cards — manual creation', () => {
  it('creates a card linked to a note with fresh SM-2 defaults, due now', async () => {
    const notebookId = await insertNotebook();
    const noteId = await insertNote(notebookId, 'Manual card note');

    const res = await api.post('/api/study/cards').send({ noteId, question: 'What is Big-O?', answer: 'Growth rate bound.' });
    expect(res.status).toBe(201);
    expect(res.body.card.question).toBe('What is Big-O?');
    expect(res.body.card.answer).toBe('Growth rate bound.');
    expect(res.body.card.noteId).toBe(noteId);
    expect(res.body.card.noteTitle).toBe('Manual card note');
    expect(res.body.card.reps).toBe(0);
    expect(res.body.card.suspended).toBe(false);

    const row = await db.prepare('SELECT * FROM flashcards WHERE id = ?').get(res.body.card.id) as any;
    expect(row.ease).toBe(2.5);
    expect(row.interval_days).toBe(0);
    expect(new Date(row.due_at).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('creates a card with no note (noteId omitted)', async () => {
    const res = await api.post('/api/study/cards').send({ question: 'Standalone Q?', answer: 'Standalone A.' });
    expect(res.status).toBe(201);
    expect(res.body.card.noteId).toBeNull();
    expect(res.body.card.noteTitle).toBeUndefined();
  });

  it('rejects an empty question with 400', async () => {
    const res = await api.post('/api/study/cards').send({ question: '   ', answer: 'A.' });
    expect(res.status).toBe(400);
  });

  it('rejects an empty answer with 400', async () => {
    const res = await api.post('/api/study/cards').send({ question: 'Q?', answer: '' });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown noteId with 400', async () => {
    const res = await api.post('/api/study/cards').send({ noteId: 'does-not-exist', question: 'Q?', answer: 'A.' });
    expect(res.status).toBe(400);
  });

  it('a newly created card appears in the review queue immediately', async () => {
    const notebookId = await insertNotebook();
    const noteId = await insertNote(notebookId);

    const create = await api.post('/api/study/cards').send({ noteId, question: 'Queue me?', answer: 'Yes.' });
    expect(create.status).toBe(201);

    const queue = await api.get('/api/study/queue');
    expect(queue.status).toBe(200);
    expect(queue.body.cards.some((c: any) => c.id === create.body.card.id)).toBe(true);
  });
});

describe('POST /api/study/review — SM-2 rating transitions', () => {
  it('again: resets reps and interval to 0, drops ease by 0.2 (floor 1.3), logs a lapse, due in ~1 minute', async () => {
    const notebookId = await insertNotebook();
    const noteId = await insertNote(notebookId);
    const cardId = await insertCard(noteId, { ease: 2.5, interval_days: 10, reps: 3 });

    const res = await api.post('/api/study/review').send({ cardId, rating: 'again' });
    expect(res.status).toBe(200);
    expect(res.body.card.reps).toBe(0);

    const row = await db.prepare('SELECT * FROM flashcards WHERE id = ?').get(cardId) as any;
    expect(row.interval_days).toBe(0);
    expect(row.reps).toBe(0);
    expect(row.ease).toBeCloseTo(2.3, 5);
    expect(row.lapses).toBe(1);

    const dueAt = new Date(row.due_at).getTime();
    const expected = Date.now() + 60_000;
    expect(Math.abs(dueAt - expected)).toBeLessThan(5_000);
  });

  it('again floors ease at 1.3 rather than going lower', async () => {
    const notebookId = await insertNotebook();
    const noteId = await insertNote(notebookId);
    const cardId = await insertCard(noteId, { ease: 1.35 });

    await api.post('/api/study/review').send({ cardId, rating: 'again' });

    const row = await db.prepare('SELECT * FROM flashcards WHERE id = ?').get(cardId) as any;
    expect(row.ease).toBe(1.3);
  });

  it('hard on an established card: interval *= 1.2, ease -= 0.15, reps increments', async () => {
    const notebookId = await insertNotebook();
    const noteId = await insertNote(notebookId);
    const cardId = await insertCard(noteId, { ease: 2.5, interval_days: 4, reps: 3 });

    const res = await api.post('/api/study/review').send({ cardId, rating: 'hard' });
    expect(res.status).toBe(200);

    const row = await db.prepare('SELECT * FROM flashcards WHERE id = ?').get(cardId) as any;
    expect(row.reps).toBe(4);
    expect(row.interval_days).toBeCloseTo(4.8, 5);
    expect(row.ease).toBeCloseTo(2.35, 5);
  });

  it('hard on a fresh card (reps 0, interval 0): due in ~10 minutes, reps and interval stay 0', async () => {
    const notebookId = await insertNotebook();
    const noteId = await insertNote(notebookId);
    const cardId = await insertCard(noteId, { ease: 2.5, interval_days: 0, reps: 0 });

    const res = await api.post('/api/study/review').send({ cardId, rating: 'hard' });
    expect(res.status).toBe(200);

    const row = await db.prepare('SELECT * FROM flashcards WHERE id = ?').get(cardId) as any;
    expect(row.reps).toBe(0);
    expect(row.interval_days).toBe(0);
    expect(row.ease).toBeCloseTo(2.35, 5);

    const dueAt = new Date(row.due_at).getTime();
    const expected = Date.now() + 600_000;
    expect(Math.abs(dueAt - expected)).toBeLessThan(5_000);
  });

  it('good on a fresh card (reps 0 -> 1): interval becomes 1 day flat, ease unchanged', async () => {
    const notebookId = await insertNotebook();
    const noteId = await insertNote(notebookId);
    const cardId = await insertCard(noteId, { ease: 2.5, interval_days: 0, reps: 0 });

    const res = await api.post('/api/study/review').send({ cardId, rating: 'good' });
    expect(res.status).toBe(200);

    const row = await db.prepare('SELECT * FROM flashcards WHERE id = ?').get(cardId) as any;
    expect(row.reps).toBe(1);
    expect(row.interval_days).toBe(1);
    expect(row.ease).toBe(2.5);

    const dueAt = new Date(row.due_at).getTime();
    const expected = Date.now() + 86_400_000;
    expect(Math.abs(dueAt - expected)).toBeLessThan(5_000);
  });

  it('good on an established card (reps > 1): interval = interval * ease', async () => {
    const notebookId = await insertNotebook();
    const noteId = await insertNote(notebookId);
    const cardId = await insertCard(noteId, { ease: 2.5, interval_days: 3, reps: 1 });

    const res = await api.post('/api/study/review').send({ cardId, rating: 'good' });
    expect(res.status).toBe(200);

    const row = await db.prepare('SELECT * FROM flashcards WHERE id = ?').get(cardId) as any;
    expect(row.reps).toBe(2);
    expect(row.interval_days).toBeCloseTo(7.5, 5); // 3 * 2.5
    expect(row.ease).toBe(2.5);
  });

  it('easy on an established card: interval = interval * (ease + 0.15) * 1.3, ease += 0.15, reps increments', async () => {
    const notebookId = await insertNotebook();
    const noteId = await insertNote(notebookId);
    const cardId = await insertCard(noteId, { ease: 2.0, interval_days: 5, reps: 2 });

    const res = await api.post('/api/study/review').send({ cardId, rating: 'easy' });
    expect(res.status).toBe(200);

    const row = await db.prepare('SELECT * FROM flashcards WHERE id = ?').get(cardId) as any;
    expect(row.reps).toBe(3);
    expect(row.ease).toBeCloseTo(2.15, 5);
    expect(row.interval_days).toBeCloseTo(5 * 2.15 * 1.3, 5);
  });

  it('easy on a fresh card (reps 0, interval 0): interval jumps to 4 days, reps -> 1', async () => {
    const notebookId = await insertNotebook();
    const noteId = await insertNote(notebookId);
    const cardId = await insertCard(noteId, { ease: 2.5, interval_days: 0, reps: 0 });

    const res = await api.post('/api/study/review').send({ cardId, rating: 'easy' });
    expect(res.status).toBe(200);

    const row = await db.prepare('SELECT * FROM flashcards WHERE id = ?').get(cardId) as any;
    expect(row.reps).toBe(1);
    expect(row.interval_days).toBe(4);
    expect(row.ease).toBeCloseTo(2.65, 5);

    const dueAt = new Date(row.due_at).getTime();
    const expected = Date.now() + 4 * 86_400_000;
    expect(Math.abs(dueAt - expected)).toBeLessThan(5_000);
  });

  it('logs every review to review_log', async () => {
    const notebookId = await insertNotebook();
    const noteId = await insertNote(notebookId);
    const cardId = await insertCard(noteId);

    await api.post('/api/study/review').send({ cardId, rating: 'good' });

    const rows = await db.prepare('SELECT * FROM review_log WHERE card_id = ?').all(cardId) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].rating).toBe('good');
  });

  it('rejects an unknown cardId with 404 and an invalid rating with 400', async () => {
    const missing = await api.post('/api/study/review').send({ cardId: 'does-not-exist', rating: 'good' });
    expect(missing.status).toBe(404);

    const notebookId = await insertNotebook();
    const noteId = await insertNote(notebookId);
    const cardId = await insertCard(noteId);
    const bad = await api.post('/api/study/review').send({ cardId, rating: 'sort-of' });
    expect(bad.status).toBe(400);
  });
});

describe('GET /api/study/stats', () => {
  it('reports due, total, reviewedToday, and per-note breakdown', async () => {
    const notebookId = await insertNotebook();
    const noteA = await insertNote(notebookId, 'Note A');
    const noteB = await insertNote(notebookId, 'Note B');

    await insertCard(noteA, { due_at: isoMinutesFromNow(-5) });
    await insertCard(noteA, { due_at: isoMinutesFromNow(60) });
    const reviewedCard = await insertCard(noteB, { due_at: isoMinutesFromNow(-5) });

    await api.post('/api/study/review').send({ cardId: reviewedCard, rating: 'good' });

    const res = await api.get('/api/study/stats');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.reviewedToday).toBeGreaterThanOrEqual(1);

    const byNote = res.body.byNote as Array<{ noteId: string; noteTitle: string; total: number; due: number }>;
    const a = byNote.find(n => n.noteId === noteA)!;
    const b = byNote.find(n => n.noteId === noteB)!;
    expect(a.total).toBe(2);
    expect(a.due).toBe(1);
    expect(b.total).toBe(1);
  });
});

describe('PATCH/DELETE /api/study/cards/:id', () => {
  it('updates question/answer/suspended', async () => {
    const notebookId = await insertNotebook();
    const noteId = await insertNote(notebookId);
    const cardId = await insertCard(noteId);

    const res = await api.patch(`/api/study/cards/${cardId}`).send({ question: 'New Q?', suspended: true });
    expect(res.status).toBe(200);
    expect(res.body.card.question).toBe('New Q?');
    expect(res.body.card.suspended).toBe(true);

    const queue = await api.get('/api/study/queue');
    expect(queue.body.cards.find((c: any) => c.id === cardId)).toBeUndefined();
  });

  it('404s when updating an unknown card', async () => {
    const res = await api.patch('/api/study/cards/nope').send({ question: 'x' });
    expect(res.status).toBe(404);
  });

  it('deletes a card', async () => {
    const notebookId = await insertNotebook();
    const noteId = await insertNote(notebookId);
    const cardId = await insertCard(noteId);

    const res = await api.delete(`/api/study/cards/${cardId}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const missing = await api.delete(`/api/study/cards/${cardId}`);
    expect(missing.status).toBe(404);
  });
});
