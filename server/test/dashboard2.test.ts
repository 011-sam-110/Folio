import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { db, newId } from '../src/db.js';
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

// The dashboard aggregates across notes, versions, flashcards and comments - all of
// which are now owner-scoped - so every fixture belongs to `user`.
let user: TestUser;
let api: TestUser['agent'];

const FAR_PAST = new Date(Date.now() - 60 * 86_400_000).toISOString(); // 60 days ago: outside any "this week" window

function isoMinutesFromNow(mins: number): string {
  return new Date(Date.now() + mins * 60_000).toISOString();
}
function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

/** Local (test-runner) midnight of the Monday of the current week - an independent
 *  re-derivation of the same Mon-Sun/local-tz rule the route is expected to implement,
 *  used here purely as ground truth for the boundary test below. */
function localMondayOfThisWeek(): Date {
  const now = new Date();
  const diffToMonday = (now.getDay() + 6) % 7;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - diffToMonday, 0, 0, 0, 0);
}

async function insertNotebook(name = 'Test notebook', overrides: Partial<{ emoji: string; color: string; archived: number }> = {}): Promise<string> {
  return mkNotebook(user.id, { name, ...overrides });
}

async function insertNote(
  notebookId: string,
  opts: Partial<{ title: string; content_text: string; content_json: string; created_at: string; updated_at: string; archived: number }> = {},
): Promise<string> {
  return mkNote(user.id, notebookId, { created_at: FAR_PAST, ...opts });
}

async function insertVersion(noteId: string, createdAt: string): Promise<void> {
  await db.prepare(
    `INSERT INTO note_versions (note_id, title, content_json, cause, created_at) VALUES (?, 'v', '{"type":"doc","content":[]}', 'autosave', ?)`,
  ).run(noteId, createdAt);
}

async function insertCard(noteId: string, opts: Partial<{ question: string; answer: string; due_at: string; suspended: number }> = {}): Promise<string> {
  return mkCard(user.id, noteId, { due_at: isoMinutesFromNow(-5), ...opts });
}

async function insertComment(noteId: string, resolved = 0): Promise<void> {
  await db.prepare(`INSERT INTO note_comments (id, note_id, anchor_text, body, resolved) VALUES (?, ?, ?, ?, ?)`).run(
    newId(),
    noteId,
    'some anchored text',
    'a margin note',
    resolved,
  );
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

const LONG_TEXT = Array.from({ length: 220 }, (_, i) => `word${i}`).join(' '); // > 200 words
const SHORT_TEXT = 'just a few words here';


describe('GET /api/dashboard - response shape', () => {
  it('includes weekGrid (7 Mon-Sun entries), weeklyReview, and recall alongside the existing v1 fields', async () => {
    const nbId = await insertNotebook('Databases', { emoji: '🗄️', color: '#0ea5e9' });
    const noteId = await insertNote(nbId, { title: 'B-Trees & Indexing' });
    await insertCard(noteId);

    const res = await api.get('/api/dashboard');
    expect(res.status).toBe(200);

    // v1 fields still present (untouched contract)
    expect(res.body).toHaveProperty('recent');
    expect(res.body).toHaveProperty('pinned');
    expect(res.body).toHaveProperty('continueNote');
    expect(res.body).toHaveProperty('stats');
    expect(res.body).toHaveProperty('weekActivity');
    expect(res.body).toHaveProperty('notebooks');

    const grid = res.body.weekGrid;
    expect(Array.isArray(grid)).toBe(true);
    expect(grid).toHaveLength(7);
    expect(grid.map((d: any) => d.dayLabel)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    for (const d of grid) {
      expect(typeof d.date).toBe('string');
      expect(typeof d.total).toBe('number');
      expect(Array.isArray(d.byNotebook)).toBe(true);
    }

    expect(res.body.weeklyReview).toMatchObject({
      notesEditedThisWeek: expect.any(Number),
      flashcardsDue: expect.any(Number),
      notesWithoutSummary: expect.any(Number),
      unresolvedComments: expect.any(Number),
    });
    expect(Array.isArray(res.body.weeklyReview.suggestions)).toBe(true);
    expect(res.body.weeklyReview.suggestions.length).toBeLessThanOrEqual(4);

    expect(Array.isArray(res.body.recall)).toBe(true);
    const entry = res.body.recall.find((r: any) => r.notebook.id === nbId);
    expect(entry).toBeTruthy();
    expect(entry.notebook).toMatchObject({ id: nbId, name: 'Databases', emoji: '🗄️', color: '#0ea5e9' });
    expect(entry.lastNote.id).toBe(noteId);
    expect(entry.quiz).toMatchObject({ question: 'Q?', answer: 'A.' });
  });
});

describe('GET /api/dashboard - weekGrid Monday-start / local-tz boundaries', () => {
  it('counts activity inside the current Mon-Sun week and excludes activity just outside it', async () => {
    const nbId = await insertNotebook('Algorithms');
    // Note's own created/updated timestamps are pinned far outside the week so they can't
    // leak a stray activity event into the window under test - only the versions below are.
    const noteId = await insertNote(nbId, { created_at: FAR_PAST, updated_at: FAR_PAST });

    const monday = localMondayOfThisWeek();
    const insideMonday = new Date(monday.getTime() + 1_000); // Mon 00:00:01 local - inside the week
    const beforeMonday = new Date(monday.getTime() - 1_000); // previous Sun 23:59:59 local - previous week
    const nextMonday = new Date(monday.getTime() + 7 * 86_400_000); // exactly next week's start - exclusive bound

    await insertVersion(noteId, insideMonday.toISOString());
    await insertVersion(noteId, beforeMonday.toISOString());
    await insertVersion(noteId, nextMonday.toISOString());

    const res = await api.get('/api/dashboard');
    expect(res.status).toBe(200);
    const grid = res.body.weekGrid as Array<{ date: string; dayLabel: string; total: number; byNotebook: Array<{ id: string; count: number }> }>;

    expect(grid[0].dayLabel).toBe('Mon');
    expect(grid[0].total).toBe(1);
    expect(grid[0].byNotebook).toEqual([{ id: nbId, emoji: '📓', color: '#4f46e5', count: 1 }]);

    const totalAcrossWeek = grid.reduce((sum, d) => sum + d.total, 0);
    expect(totalAcrossWeek).toBe(1); // the before/after-week versions must not surface anywhere in the grid
  });
});

describe('GET /api/dashboard - recall', () => {
  it('picks the quiz card from the SAME notebook, never a different one', async () => {
    const nbA = await insertNotebook('Notebook A');
    const nbB = await insertNotebook('Notebook B');
    const noteA = await insertNote(nbA, { title: 'Note A' });
    const noteB = await insertNote(nbB, { title: 'Note B' });
    await insertCard(noteA, { question: 'A-question', answer: 'A-answer' });
    await insertCard(noteB, { question: 'B-question', answer: 'B-answer' });

    const res = await api.get('/api/dashboard');
    const entryA = res.body.recall.find((r: any) => r.notebook.id === nbA);
    const entryB = res.body.recall.find((r: any) => r.notebook.id === nbB);

    expect(entryA.quiz.question).toBe('A-question');
    expect(entryB.quiz.question).toBe('B-question');
  });

  it('prefers an oldest-due card over a not-yet-due card in the same notebook', async () => {
    const nbId = await insertNotebook();
    const noteId = await insertNote(nbId);
    await insertCard(noteId, { question: 'future-card', answer: 'x', due_at: isoDaysFromNow(5) });
    await insertCard(noteId, { question: 'due-card', answer: 'y', due_at: isoMinutesFromNow(-10) });

    const res = await api.get('/api/dashboard');
    const entry = res.body.recall.find((r: any) => r.notebook.id === nbId);
    expect(entry.quiz.question).toBe('due-card');
  });

  it('falls back to a random (non-suspended) card when nothing in the notebook is due yet', async () => {
    const nbId = await insertNotebook();
    const noteId = await insertNote(nbId);
    await insertCard(noteId, { question: 'not-due-yet', answer: 'z', due_at: isoDaysFromNow(3) });

    const res = await api.get('/api/dashboard');
    const entry = res.body.recall.find((r: any) => r.notebook.id === nbId);
    expect(entry.quiz).toMatchObject({ question: 'not-due-yet', answer: 'z' });
  });

  it('orders by daysSince desc, with never-touched (no-note) notebooks last', async () => {
    const nbOld = await insertNotebook('Old notebook'); // edited 10 days ago
    const nbRecent = await insertNotebook('Recent notebook'); // edited 1 day ago
    const nbEmpty = await insertNotebook('Empty notebook'); // no notes at all

    await insertNote(nbOld, { updated_at: new Date(Date.now() - 10 * 86_400_000).toISOString() });
    await insertNote(nbRecent, { updated_at: new Date(Date.now() - 1 * 86_400_000).toISOString() });

    const res = await api.get('/api/dashboard');
    const recall = res.body.recall as Array<{ notebook: { id: string }; daysSince: number | null; lastNote: unknown }>;

    const idxOld = recall.findIndex(r => r.notebook.id === nbOld);
    const idxRecent = recall.findIndex(r => r.notebook.id === nbRecent);
    const idxEmpty = recall.findIndex(r => r.notebook.id === nbEmpty);

    expect(idxOld).toBeGreaterThanOrEqual(0);
    expect(idxRecent).toBeGreaterThanOrEqual(0);
    expect(idxEmpty).toBeGreaterThanOrEqual(0);
    expect(idxOld).toBeLessThan(idxRecent); // 10 days ago sorts before 1 day ago (desc)
    expect(idxRecent).toBeLessThan(idxEmpty); // any real note beats "nothing to recall"

    const emptyEntry = recall[idxEmpty];
    expect(emptyEntry.daysSince).toBeNull();
    expect(emptyEntry.lastNote).toBeNull();
  });
});

describe('GET /api/dashboard - weeklyReview counts', () => {
  it('computes notesEditedThisWeek, notesWithoutSummary (word-count + h2/callout aware), and unresolvedComments', async () => {
    const nbId = await insertNotebook('Software Engineering');

    // Edited this week vs. not.
    await insertNote(nbId, { title: 'Edited today', content_text: SHORT_TEXT, updated_at: new Date().toISOString() });
    await insertNote(nbId, { title: 'Edited long ago', content_text: SHORT_TEXT, updated_at: FAR_PAST });

    // Long note with no summary marker -> counts.
    const longNoSummary = await insertNote(nbId, { title: 'Long, no summary', content_text: LONG_TEXT });
    // Long note with an literal H2 "Summary" heading -> excluded.
    const longWithSummaryHeading = await insertNote(nbId, {
      title: 'Long, has summary heading',
      content_text: LONG_TEXT,
      content_json: JSON.stringify({
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Summary' }] },
          { type: 'paragraph', content: [{ type: 'text', text: LONG_TEXT }] },
        ],
      }),
    });
    // Long note with a callout block -> excluded.
    const longWithCallout = await insertNote(nbId, {
      title: 'Long, has callout',
      content_text: LONG_TEXT,
      content_json: JSON.stringify({
        type: 'doc',
        content: [{ type: 'callout', attrs: { emoji: '💡', tone: 'info' }, content: [{ type: 'paragraph' }] }],
      }),
    });
    // Short note (<=200 words), no summary -> not counted regardless.
    await insertNote(nbId, { title: 'Short, no summary', content_text: SHORT_TEXT });

    // Two unresolved comments, one resolved.
    await insertComment(longNoSummary, 0);
    await insertComment(longWithSummaryHeading, 0);
    await insertComment(longWithCallout, 1);

    const res = await api.get('/api/dashboard');
    expect(res.status).toBe(200);
    const review = res.body.weeklyReview;

    expect(review.notesEditedThisWeek).toBe(1); // only "Edited today"
    expect(review.notesWithoutSummary).toBe(1); // only "Long, no summary"
    expect(review.unresolvedComments).toBe(2);
  });

  it('includes a per-notebook due-card suggestion in the example phrasing', async () => {
    const nbId = await insertNotebook('Databases');
    const noteId = await insertNote(nbId);
    await insertCard(noteId, { due_at: isoMinutesFromNow(-5) });
    await insertCard(noteId, { due_at: isoMinutesFromNow(-5) });

    const res = await api.get('/api/dashboard');
    const suggestions: string[] = res.body.weeklyReview.suggestions;
    expect(suggestions.some(s => s === 'Databases has 2 cards due - 10 min review?')).toBe(true);
  });
});
