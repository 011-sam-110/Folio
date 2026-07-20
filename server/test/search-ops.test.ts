import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { db, newId, nowIso } from '../src/db.js';
import {
  resetDatabase,
  resetData,
  makeUser,
  closeDatabase,
  insertNotebook as mkNotebook,
  insertNote as mkNote,
  type TestUser,
} from './helpers.js';

const app = buildApp();

// Search is owner-scoped, so the fixtures below belong to `user` and the queries are
// issued as `user`. A second account is created in the isolation test at the bottom.
let user: TestUser;
let api: TestUser['agent'];

async function insertNotebook(name: string): Promise<string> {
  return mkNotebook(user.id, { name });
}

async function insertNote(
  notebookId: string,
  title: string,
  contentText: string,
  opts: Partial<{ archived: number }> = {},
): Promise<string> {
  return mkNote(user.id, notebookId, { title, content_text: contentText, archived: opts.archived ?? 0 });
}

async function tagNote(noteId: string, tag: string): Promise<void> {
  await db.prepare('INSERT INTO note_tags (note_id, tag) VALUES (?, ?)').run(noteId, tag);
}

function ids(res: request.Response): string[] {
  return (res.body.results as Array<{ note: { id: string } }>).map(r => r.note.id);
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

describe('GET /api/search — phrase match', () => {
  it('an "exact phrase" only matches notes where the words are adjacent, not just co-occurring', async () => {
    const nbId = await insertNotebook('Algorithms');
    const adjacent = await insertNote(nbId, 'BST note', 'Binary search trees provide O(log n) lookup for sorted data.');
    await insertNote(nbId, 'Binary rep note', 'You can search in binary or decimal representations of these trees.');

    const res = await api.get('/api/search').query({ q: '"binary search"' });
    expect(res.status).toBe(200);
    expect(res.body.parsed).toEqual({ terms: [], phrases: ['binary search'], excluded: [], tag: null, notebook: null });
    expect(ids(res)).toEqual([adjacent]);
    expect(res.body.results[0].snippetHtml).toContain('<mark>');
  });
});

describe('GET /api/search — exclusion', () => {
  it('-word drops notes containing the excluded term', async () => {
    const nbId = await insertNotebook('Algorithms');
    const keep = await insertNote(nbId, 'Quicksort', 'Quicksort is a divide and conquer sorting algorithm.');
    await insertNote(nbId, 'Merge sort', 'Merge sort is also a divide and conquer sorting algorithm but stable.');

    const res = await api.get('/api/search').query({ q: 'divide -merge' });
    expect(res.status).toBe(200);
    expect(res.body.parsed.excluded).toEqual(['merge']);
    expect(ids(res)).toEqual([keep]);
  });

  it('a bare exclusion with no positive criteria returns no results, never 500', async () => {
    const nbId = await insertNotebook('Algorithms');
    await insertNote(nbId, 'Note', 'Merge sort content.');

    const res = await api.get('/api/search').query({ q: '-merge' });
    expect(res.status).toBe(200);
    expect(res.body.parsed.excluded).toEqual(['merge']);
    expect(res.body.results).toEqual([]);
  });
});

describe('GET /api/search — tag filter', () => {
  it('tag:name filters to notes carrying that exact tag, with no text term required', async () => {
    const nbId = await insertNotebook('Algorithms');
    const tagged = await insertNote(nbId, 'Week 3 note', 'Balanced trees this week.');
    await tagNote(tagged, 'week3');
    const untagged = await insertNote(nbId, 'Other note', 'Balanced trees again.');
    void untagged;

    const res = await api.get('/api/search').query({ q: 'tag:week3' });
    expect(res.status).toBe(200);
    expect(res.body.parsed).toEqual({ terms: [], phrases: [], excluded: [], tag: 'week3', notebook: null });
    expect(ids(res)).toEqual([tagged]);
    // No FTS row backs this branch, so score falls back to 0 and the snippet is
    // the plain note snippet rather than a <mark>-highlighted FTS one.
    expect(res.body.results[0].score).toBe(0);
  });

  it('excludes archived notes from a tag-only browse', async () => {
    const nbId = await insertNotebook('Algorithms');
    const archived = await insertNote(nbId, 'Archived note', 'Old content.', { archived: 1 });
    await tagNote(archived, 'week3');

    const res = await api.get('/api/search').query({ q: 'tag:week3' });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });
});

describe('GET /api/search — notebook filter', () => {
  it('notebook:name is a case-insensitive prefix match on the notebook name', async () => {
    const algo = await insertNotebook('Algorithms & Data Structures');
    const db2 = await insertNotebook('Databases');
    const inAlgo = await insertNote(algo, 'Note A', 'Some content about complexity.');
    await insertNote(db2, 'Note B', 'Some content about complexity.');

    const res = await api.get('/api/search').query({ q: 'notebook:algorithms' });
    expect(res.status).toBe(200);
    expect(res.body.parsed.notebook).toBe('algorithms');
    expect(ids(res)).toEqual([inAlgo]);
  });
});

describe('GET /api/search — combination', () => {
  it('tag: + a bareword term must both match (FTS branch honours the tag join)', async () => {
    const nbId = await insertNotebook('Databases');
    const match = await insertNote(nbId, 'Normalization', 'Normal forms reduce redundancy in relational database design.');
    await tagNote(match, 'week1');
    const wrongTag = await insertNote(nbId, 'Other normalization note', 'Redundancy elimination is part of relational design too.');
    void wrongTag;

    const res = await api.get('/api/search').query({ q: 'tag:week1 redundancy' });
    expect(res.status).toBe(200);
    expect(res.body.parsed.tag).toBe('week1');
    expect(res.body.parsed.terms).toEqual(['redundancy']);
    expect(ids(res)).toEqual([match]);
  });

  it('notebook: + phrase + exclusion compose correctly', async () => {
    const algo = await insertNotebook('Algorithms & Data Structures');
    const other = await insertNotebook('Databases');
    const want = await insertNote(algo, 'Good', 'A binary search tree keeps its keys sorted for fast lookup.');
    await insertNote(algo, 'Excluded by word', 'A binary search tree is unbalanced and slow today.');
    await insertNote(other, 'Wrong notebook', 'A binary search tree keeps its keys sorted for fast lookup.');

    const res = await api.get('/api/search').query({ q: 'notebook:Algorithms "binary search tree" -unbalanced' });
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([want]);
  });
});

describe('GET /api/search — hostile input', () => {
  const hostileQueries = [
    `'; DROP TABLE notes; --`,
    '***',
    '"unterminated phrase',
    '-----',
    'a AND ) *** OR "',
    'tag:',
    'notebook:',
    '           ',
    '"" "" ""',
    'foo" OR "1"="1',
  ];

  it.each(hostileQueries)('never 500s on %j and the database survives intact', async (q) => {
    const res = await api.get('/api/search').query({ q });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.results)).toBe(true);
    expect(res.body.parsed).toBeTruthy();
  });

  it('really did not drop the notes table', async () => {
    const nbId = await insertNotebook('Survives');
    await insertNote(nbId, 'Still here', 'proof of life');
    await api.get('/api/search').query({ q: `'; DROP TABLE notes; --` });
    const res = await api.get('/api/search').query({ q: 'proof' });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
  });
});

describe('GET /api/search — empty', () => {
  it('missing q returns no results with an all-empty parsed echo', async () => {
    const res = await api.get('/api/search');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      results: [],
      parsed: { terms: [], phrases: [], excluded: [], tag: null, notebook: null },
    });
  });

  it('empty string q behaves the same as missing q', async () => {
    const res = await api.get('/api/search').query({ q: '' });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });

  it('whitespace-only q parses to nothing usable', async () => {
    const res = await api.get('/api/search').query({ q: '   ' });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });
});
