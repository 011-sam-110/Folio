import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';

// The DB connection is opened at import time (server/src/db.ts reads FOLIO_DB_PATH via
// config.ts), so the env var must be set BEFORE anything that transitively imports it.
// Static `import` statements are hoisted above this, so we set the env var here and
// pull in the app modules with dynamic imports afterwards.
const dbPath = path.join(os.tmpdir(), `folio-study-test-${process.pid}-${Date.now()}.db`);
process.env.FOLIO_DB_PATH = dbPath;

const { db, newId } = await import('../src/db.js');
const { buildApp } = await import('../src/app.js');

const app = buildApp();

function isoMinutesFromNow(mins: number): string {
  return new Date(Date.now() + mins * 60_000).toISOString();
}

function insertNotebook(): string {
  const id = newId();
  db.prepare('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(id, 'Test notebook');
  return id;
}

function insertNote(notebookId: string, title = 'Test note'): string {
  const id = newId();
  db.prepare('INSERT INTO notes (id, notebook_id, title, content_text) VALUES (?, ?, ?, ?)').run(id, notebookId, title, 'some content');
  return id;
}

function insertCard(
  noteId: string | null,
  opts: Partial<{ question: string; answer: string; ease: number; interval_days: number; reps: number; lapses: number; due_at: string; suspended: number }> = {},
): string {
  const id = newId();
  db.prepare(
    `INSERT INTO flashcards (id, note_id, question, answer, ease, interval_days, reps, lapses, due_at, suspended)
     VALUES (@id, @note_id, @question, @answer, @ease, @interval_days, @reps, @lapses, @due_at, @suspended)`,
  ).run({
    id,
    note_id: noteId,
    question: opts.question ?? 'Q?',
    answer: opts.answer ?? 'A.',
    ease: opts.ease ?? 2.5,
    interval_days: opts.interval_days ?? 0,
    reps: opts.reps ?? 0,
    lapses: opts.lapses ?? 0,
    due_at: opts.due_at ?? isoMinutesFromNow(-5), // due 5 minutes ago by default
    suspended: opts.suspended ?? 0,
  });
  return id;
}

beforeEach(() => {
  // Isolate every test: wipe all study-relevant tables (and their FK-dependent notes).
  db.exec('DELETE FROM review_log; DELETE FROM flashcards; DELETE FROM note_versions; DELETE FROM links; DELETE FROM note_tags; DELETE FROM notes; DELETE FROM notebooks;');
});

afterAll(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {
      /* best-effort cleanup */
    }
  }
});

describe('GET /api/study/queue', () => {
  it('only returns due, non-suspended cards, and reports due/total counts', async () => {
    const notebookId = insertNotebook();
    const noteId = insertNote(notebookId);

    insertCard(noteId, { due_at: isoMinutesFromNow(-10) }); // due
    insertCard(noteId, { due_at: isoMinutesFromNow(-1) }); // due
    insertCard(noteId, { due_at: isoMinutesFromNow(60) }); // not due yet
    insertCard(noteId, { due_at: isoMinutesFromNow(-10), suspended: 1 }); // suspended, excluded

    const res = await request(app).get('/api/study/queue');
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
    const notebookId = insertNotebook();
    const noteId = insertNote(notebookId);
    for (let i = 0; i < 5; i++) insertCard(noteId, { due_at: isoMinutesFromNow(-1) });

    const res = await request(app).get('/api/study/queue?limit=2');
    expect(res.status).toBe(200);
    expect(res.body.cards).toHaveLength(2);
    expect(res.body.due).toBe(5);
  });
});

describe('POST /api/study/review — SM-2 rating transitions', () => {
  it('again: resets reps and interval to 0, drops ease by 0.2 (floor 1.3), logs a lapse, due in ~1 minute', async () => {
    const notebookId = insertNotebook();
    const noteId = insertNote(notebookId);
    const cardId = insertCard(noteId, { ease: 2.5, interval_days: 10, reps: 3 });

    const res = await request(app).post('/api/study/review').send({ cardId, rating: 'again' });
    expect(res.status).toBe(200);
    expect(res.body.card.reps).toBe(0);

    const row = db.prepare('SELECT * FROM flashcards WHERE id = ?').get(cardId) as any;
    expect(row.interval_days).toBe(0);
    expect(row.reps).toBe(0);
    expect(row.ease).toBeCloseTo(2.3, 5);
    expect(row.lapses).toBe(1);

    const dueAt = new Date(row.due_at).getTime();
    const expected = Date.now() + 60_000;
    expect(Math.abs(dueAt - expected)).toBeLessThan(5_000);
  });

  it('again floors ease at 1.3 rather than going lower', async () => {
    const notebookId = insertNotebook();
    const noteId = insertNote(notebookId);
    const cardId = insertCard(noteId, { ease: 1.35 });

    await request(app).post('/api/study/review').send({ cardId, rating: 'again' });

    const row = db.prepare('SELECT * FROM flashcards WHERE id = ?').get(cardId) as any;
    expect(row.ease).toBe(1.3);
  });

  it('hard on an established card: interval *= 1.2, ease -= 0.15, reps increments', async () => {
    const notebookId = insertNotebook();
    const noteId = insertNote(notebookId);
    const cardId = insertCard(noteId, { ease: 2.5, interval_days: 4, reps: 3 });

    const res = await request(app).post('/api/study/review').send({ cardId, rating: 'hard' });
    expect(res.status).toBe(200);

    const row = db.prepare('SELECT * FROM flashcards WHERE id = ?').get(cardId) as any;
    expect(row.reps).toBe(4);
    expect(row.interval_days).toBeCloseTo(4.8, 5);
    expect(row.ease).toBeCloseTo(2.35, 5);
  });

  it('hard on a fresh card (reps 0, interval 0): due in ~10 minutes, reps and interval stay 0', async () => {
    const notebookId = insertNotebook();
    const noteId = insertNote(notebookId);
    const cardId = insertCard(noteId, { ease: 2.5, interval_days: 0, reps: 0 });

    const res = await request(app).post('/api/study/review').send({ cardId, rating: 'hard' });
    expect(res.status).toBe(200);

    const row = db.prepare('SELECT * FROM flashcards WHERE id = ?').get(cardId) as any;
    expect(row.reps).toBe(0);
    expect(row.interval_days).toBe(0);
    expect(row.ease).toBeCloseTo(2.35, 5);

    const dueAt = new Date(row.due_at).getTime();
    const expected = Date.now() + 600_000;
    expect(Math.abs(dueAt - expected)).toBeLessThan(5_000);
  });

  it('good on a fresh card (reps 0 -> 1): interval becomes 1 day flat, ease unchanged', async () => {
    const notebookId = insertNotebook();
    const noteId = insertNote(notebookId);
    const cardId = insertCard(noteId, { ease: 2.5, interval_days: 0, reps: 0 });

    const res = await request(app).post('/api/study/review').send({ cardId, rating: 'good' });
    expect(res.status).toBe(200);

    const row = db.prepare('SELECT * FROM flashcards WHERE id = ?').get(cardId) as any;
    expect(row.reps).toBe(1);
    expect(row.interval_days).toBe(1);
    expect(row.ease).toBe(2.5);

    const dueAt = new Date(row.due_at).getTime();
    const expected = Date.now() + 86_400_000;
    expect(Math.abs(dueAt - expected)).toBeLessThan(5_000);
  });

  it('good on an established card (reps > 1): interval = interval * ease', async () => {
    const notebookId = insertNotebook();
    const noteId = insertNote(notebookId);
    const cardId = insertCard(noteId, { ease: 2.5, interval_days: 3, reps: 1 });

    const res = await request(app).post('/api/study/review').send({ cardId, rating: 'good' });
    expect(res.status).toBe(200);

    const row = db.prepare('SELECT * FROM flashcards WHERE id = ?').get(cardId) as any;
    expect(row.reps).toBe(2);
    expect(row.interval_days).toBeCloseTo(7.5, 5); // 3 * 2.5
    expect(row.ease).toBe(2.5);
  });

  it('easy on an established card: interval = interval * (ease + 0.15) * 1.3, ease += 0.15, reps increments', async () => {
    const notebookId = insertNotebook();
    const noteId = insertNote(notebookId);
    const cardId = insertCard(noteId, { ease: 2.0, interval_days: 5, reps: 2 });

    const res = await request(app).post('/api/study/review').send({ cardId, rating: 'easy' });
    expect(res.status).toBe(200);

    const row = db.prepare('SELECT * FROM flashcards WHERE id = ?').get(cardId) as any;
    expect(row.reps).toBe(3);
    expect(row.ease).toBeCloseTo(2.15, 5);
    expect(row.interval_days).toBeCloseTo(5 * 2.15 * 1.3, 5);
  });

  it('easy on a fresh card (reps 0, interval 0): interval jumps to 4 days, reps -> 1', async () => {
    const notebookId = insertNotebook();
    const noteId = insertNote(notebookId);
    const cardId = insertCard(noteId, { ease: 2.5, interval_days: 0, reps: 0 });

    const res = await request(app).post('/api/study/review').send({ cardId, rating: 'easy' });
    expect(res.status).toBe(200);

    const row = db.prepare('SELECT * FROM flashcards WHERE id = ?').get(cardId) as any;
    expect(row.reps).toBe(1);
    expect(row.interval_days).toBe(4);
    expect(row.ease).toBeCloseTo(2.65, 5);

    const dueAt = new Date(row.due_at).getTime();
    const expected = Date.now() + 4 * 86_400_000;
    expect(Math.abs(dueAt - expected)).toBeLessThan(5_000);
  });

  it('logs every review to review_log', async () => {
    const notebookId = insertNotebook();
    const noteId = insertNote(notebookId);
    const cardId = insertCard(noteId);

    await request(app).post('/api/study/review').send({ cardId, rating: 'good' });

    const rows = db.prepare('SELECT * FROM review_log WHERE card_id = ?').all(cardId) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].rating).toBe('good');
  });

  it('rejects an unknown cardId with 404 and an invalid rating with 400', async () => {
    const missing = await request(app).post('/api/study/review').send({ cardId: 'does-not-exist', rating: 'good' });
    expect(missing.status).toBe(404);

    const notebookId = insertNotebook();
    const noteId = insertNote(notebookId);
    const cardId = insertCard(noteId);
    const bad = await request(app).post('/api/study/review').send({ cardId, rating: 'sort-of' });
    expect(bad.status).toBe(400);
  });
});

describe('GET /api/study/stats', () => {
  it('reports due, total, reviewedToday, and per-note breakdown', async () => {
    const notebookId = insertNotebook();
    const noteA = insertNote(notebookId, 'Note A');
    const noteB = insertNote(notebookId, 'Note B');

    insertCard(noteA, { due_at: isoMinutesFromNow(-5) });
    insertCard(noteA, { due_at: isoMinutesFromNow(60) });
    const reviewedCard = insertCard(noteB, { due_at: isoMinutesFromNow(-5) });

    await request(app).post('/api/study/review').send({ cardId: reviewedCard, rating: 'good' });

    const res = await request(app).get('/api/study/stats');
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
    const notebookId = insertNotebook();
    const noteId = insertNote(notebookId);
    const cardId = insertCard(noteId);

    const res = await request(app).patch(`/api/study/cards/${cardId}`).send({ question: 'New Q?', suspended: true });
    expect(res.status).toBe(200);
    expect(res.body.card.question).toBe('New Q?');
    expect(res.body.card.suspended).toBe(true);

    const queue = await request(app).get('/api/study/queue');
    expect(queue.body.cards.find((c: any) => c.id === cardId)).toBeUndefined();
  });

  it('404s when updating an unknown card', async () => {
    const res = await request(app).patch('/api/study/cards/nope').send({ question: 'x' });
    expect(res.status).toBe(404);
  });

  it('deletes a card', async () => {
    const notebookId = insertNotebook();
    const noteId = insertNote(notebookId);
    const cardId = insertCard(noteId);

    const res = await request(app).delete(`/api/study/cards/${cardId}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const missing = await request(app).delete(`/api/study/cards/${cardId}`);
    expect(missing.status).toBe(404);
  });
});
