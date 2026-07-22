// Cross-tenant regression suite.
//
// The migration turned a single-user app into a multi-user one, and the pre-migration
// route layer filtered on nothing but the row id - so essentially every read was a
// cross-account read waiting to happen. Each test below pins one of the holes that was
// closed during the port. They are written as "user B tries to reach user A's data",
// because that is the shape the bugs actually had.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { db } from '../src/db.js';
import {
  resetDatabase,
  resetData,
  makeUser,
  closeDatabase,
  insertNotebook,
  insertNote,
  insertCard,
  type TestUser,
} from './helpers.js';

const app = buildApp();

let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetData();
  alice = await makeUser(app);
  bob = await makeUser(app);
});

afterAll(async () => {
  await closeDatabase();
});

describe('unauthenticated access', () => {
  it.each([
    ['/api/notebooks'],
    ['/api/notes'],
    ['/api/notes/recent'],
    ['/api/search?q=x'],
    ['/api/search/titles?q=x'],
    ['/api/tags'],
    ['/api/dashboard'],
    ['/api/study/queue'],
    ['/api/study/stats'],
    ['/api/templates'],
  ])('401s on GET %s without a session', async (path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(401);
  });

  it('leaves /api/health and the auth router reachable', async () => {
    expect((await request(app).get('/api/health')).status).toBe(200);
    // /me is how the client discovers it is signed out - it must answer, not 401-loop.
    expect((await request(app).get('/api/auth/me')).status).toBe(401);
  });
});

describe('notebooks are invisible across accounts', () => {
  it('does not list, read, patch or delete another account notebook', async () => {
    const nb = await insertNotebook(alice.id, { name: 'Alice private' });

    const list = await bob.agent.get('/api/notebooks');
    expect(list.body.notebooks).toHaveLength(0);

    expect((await bob.agent.patch(`/api/notebooks/${nb}`).send({ name: 'pwned' })).status).toBe(404);
    expect((await bob.agent.delete(`/api/notebooks/${nb}`)).status).toBe(404);

    // And it really was not modified.
    const row = await db.prepare('SELECT name FROM notebooks WHERE id = ?').get<{ name: string }>(nb);
    expect(row?.name).toBe('Alice private');
  });

  it('refuses to file a note into another account notebook', async () => {
    const aliceNb = await insertNotebook(alice.id);
    const res = await bob.agent.post('/api/notes').send({ notebookId: aliceNb, title: 'sneaky' });
    expect(res.status).toBe(400);
  });
});

describe('notes are invisible across accounts', () => {
  it('404s reading, patching and deleting another account note', async () => {
    const nb = await insertNotebook(alice.id);
    const note = await insertNote(alice.id, nb, { title: 'Secret', content_text: 'confidential body' });

    expect((await bob.agent.get(`/api/notes/${note}`)).status).toBe(404);
    expect((await bob.agent.patch(`/api/notes/${note}`).send({ title: 'pwned' })).status).toBe(404);
    expect((await bob.agent.delete(`/api/notes/${note}`)).status).toBe(404);
    expect((await bob.agent.get(`/api/notes/${note}/versions`)).status).toBe(404);
    expect((await bob.agent.get(`/api/notes/${note}/export?format=markdown`)).status).toBe(404);

    const row = await db.prepare('SELECT title FROM notes WHERE id = ?').get<{ title: string }>(note);
    expect(row?.title).toBe('Secret');
  });

  it('keeps another account notes out of the list and recent feeds', async () => {
    const nb = await insertNotebook(alice.id);
    await insertNote(alice.id, nb, { title: 'Alice note' });

    expect((await bob.agent.get('/api/notes')).body.total).toBe(0);
    expect((await bob.agent.get('/api/notes/recent')).body.notes).toHaveLength(0);
  });

  it('does not surface another account note as an unlinked mention', async () => {
    const aliceNb = await insertNotebook(alice.id);
    await insertNote(alice.id, aliceNb, { title: 'Alice mentions Deadlock', content_text: 'deadlock is everywhere' });

    const bobNb = await insertNotebook(bob.id);
    const bobNote = await insertNote(bob.id, bobNb, { title: 'Deadlock' });

    const res = await bob.agent.get(`/api/notes/${bobNote}/unlinked-mentions`);
    expect(res.status).toBe(200);
    expect(res.body.notes).toHaveLength(0);
  });
});

describe('search is owner-scoped', () => {
  it('does not return another account notes for a full-text query', async () => {
    const nb = await insertNotebook(alice.id);
    await insertNote(alice.id, nb, { title: 'Cryptography', content_text: 'a very distinctive passphrase here' });

    const res = await bob.agent.get('/api/search?q=passphrase');
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(0);
  });

  // The QuickSwitcher autocomplete had no owner filter at all, so any signed-in user
  // could enumerate every other account's note titles by typing letters.
  it('does not leak another account titles through /search/titles', async () => {
    const nb = await insertNotebook(alice.id);
    await insertNote(alice.id, nb, { title: 'Operating Systems Revision' });

    const res = await bob.agent.get('/api/search/titles?q=Operating');
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(0);
  });
});

describe('tags are owner-scoped', () => {
  it('does not aggregate another account tags or counts', async () => {
    const nb = await insertNotebook(alice.id);
    const note = await insertNote(alice.id, nb);
    await db.prepare('INSERT INTO note_tags (note_id, tag) VALUES (?, ?)').run(note, 'alice-only');

    const res = await bob.agent.get('/api/tags');
    expect(res.status).toBe(200);
    expect(res.body.tags).toEqual([]);
  });
});

describe('study is owner-scoped', () => {
  it('does not queue, review, patch or delete another account cards', async () => {
    const nb = await insertNotebook(alice.id);
    const note = await insertNote(alice.id, nb);
    const card = await insertCard(alice.id, note);

    const queue = await bob.agent.get('/api/study/queue');
    expect(queue.body.cards).toHaveLength(0);
    expect(queue.body.total).toBe(0);

    expect((await bob.agent.post('/api/study/review').send({ cardId: card, rating: 'good' })).status).toBe(404);
    expect((await bob.agent.patch(`/api/study/cards/${card}`).send({ suspended: true })).status).toBe(404);
    expect((await bob.agent.delete(`/api/study/cards/${card}`)).status).toBe(404);
  });

  // Creating a card used to accept any note id and echo that note's title back in the
  // card DTO - a cross-tenant read through the create endpoint.
  it('refuses to attach a new card to another account note', async () => {
    const nb = await insertNotebook(alice.id);
    const note = await insertNote(alice.id, nb, { title: 'Alice secret title' });

    const res = await bob.agent.post('/api/study/cards').send({ noteId: note, question: 'Q?', answer: 'A.' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('Alice secret title');
  });

  it('does not count another account reviews in reviewedToday', async () => {
    const nb = await insertNotebook(alice.id);
    const note = await insertNote(alice.id, nb);
    const card = await insertCard(alice.id, note);
    await alice.agent.post('/api/study/review').send({ cardId: card, rating: 'good' });

    const stats = await bob.agent.get('/api/study/stats');
    expect(stats.status).toBe(200);
    expect(stats.body.reviewedToday).toBe(0);
  });
});

describe('dashboard is owner-scoped', () => {
  it('counts none of another account notes, notebooks or activity', async () => {
    const nb = await insertNotebook(alice.id, { name: 'Alice notebook' });
    const note = await insertNote(alice.id, nb, { title: 'Alice note', pinned: 1 });
    await db
      .prepare(
        `INSERT INTO note_versions (note_id, title, content_json, cause, created_at)
         VALUES (?, 'v', '{"type":"doc","content":[]}', 'autosave', ?)`,
      )
      .run(note, new Date().toISOString());

    const res = await bob.agent.get('/api/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.stats).toMatchObject({ notes: 0, notebooks: 0 });
    expect(res.body.pinned).toHaveLength(0);
    expect(res.body.recent).toHaveLength(0);
    expect(res.body.notebooks).toHaveLength(0);
    // The 14-day heatmap joins note_versions, which carries no user_id of its own.
    expect(res.body.weekActivity.reduce((sum: number, d: { count: number }) => sum + d.count, 0)).toBe(0);
  });
});

describe('AI endpoints are owner-scoped', () => {
  // getNote() had no owner filter, so any signed-in user could pipe any other user's
  // note into the model and read it back in the response.
  it.each(['improve', 'summarize', 'flashcards', 'clean', 'gaps', 'title'])(
    '404s on POST /api/ai/%s for another account note',
    async (endpoint) => {
      const nb = await insertNotebook(alice.id);
      const note = await insertNote(alice.id, nb, { content_text: 'confidential body text' });

      const res = await bob.agent.post(`/api/ai/${endpoint}`).send({ noteId: note });
      expect(res.status).toBe(404);
    },
  );
});

describe('wikilinks never cross accounts', () => {
  // Title resolution was a bare `lower(title) = lower(?)` across the whole table, so two
  // users with a note of the same name would have linked into each other's graphs.
  it('resolves a wikilink only within the linking account', async () => {
    const aliceNb = await insertNotebook(alice.id);
    const aliceTarget = await insertNote(alice.id, aliceNb, { title: 'Physics' });

    const bobNb = await insertNotebook(bob.id);
    const bobSource = await bob.agent
      .post('/api/notes')
      .send({ notebookId: bobNb, title: 'Bob source', contentText: 'See [[Physics]] for detail.' });
    expect(bobSource.status).toBe(201);

    // Bob has no note called Physics, so the link must simply not resolve.
    const detail = await bob.agent.get(`/api/notes/${bobSource.body.note.id}`);
    expect(detail.body.outgoingLinks).toHaveLength(0);

    // And nothing was written pointing at Alice's note.
    const rows = await db
      .prepare('SELECT COUNT(*) as c FROM links WHERE to_note_id = ?')
      .get<{ c: number }>(aliceTarget);
    expect(rows?.c).toBe(0);
  });

  it('resolves a wikilink within the same account as normal', async () => {
    const nb = await insertNotebook(bob.id);
    const target = await insertNote(bob.id, nb, { title: 'Physics' });
    const source = await bob.agent
      .post('/api/notes')
      .send({ notebookId: nb, title: 'Bob source', contentText: 'See [[Physics]] for detail.' });

    const detail = await bob.agent.get(`/api/notes/${source.body.note.id}`);
    expect(detail.body.outgoingLinks.map((n: { id: string }) => n.id)).toEqual([target]);
  });
});
