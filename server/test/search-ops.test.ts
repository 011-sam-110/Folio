import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';

// The DB connection is opened at import time (server/src/db.ts reads FOLIO_DB_PATH via
// config.ts), so the env var must be set BEFORE anything that transitively imports it.
// Static `import` statements are hoisted above this, so we set the env var here and
// pull in the app modules with dynamic imports afterwards (same pattern as study.test.ts).
const dbPath = path.join(os.tmpdir(), `folio-search-ops-test-${process.pid}-${Date.now()}.db`);
process.env.FOLIO_DB_PATH = dbPath;

const { db, newId } = await import('../src/db.js');
const { buildApp } = await import('../src/app.js');

const app = buildApp();

function insertNotebook(name: string): string {
  const id = newId();
  db.prepare('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(id, name);
  return id;
}

function insertNote(
  notebookId: string,
  title: string,
  contentText: string,
  opts: Partial<{ archived: number }> = {},
): string {
  const id = newId();
  db.prepare('INSERT INTO notes (id, notebook_id, title, content_text, archived) VALUES (?, ?, ?, ?, ?)').run(
    id,
    notebookId,
    title,
    contentText,
    opts.archived ?? 0,
  );
  return id;
}

function tagNote(noteId: string, tag: string): void {
  db.prepare('INSERT INTO note_tags (note_id, tag) VALUES (?, ?)').run(noteId, tag);
}

function ids(res: request.Response): string[] {
  return (res.body.results as Array<{ note: { id: string } }>).map(r => r.note.id);
}

beforeEach(() => {
  db.exec(
    'DELETE FROM review_log; DELETE FROM flashcards; DELETE FROM note_versions; DELETE FROM links; DELETE FROM note_tags; DELETE FROM notes; DELETE FROM notebooks;',
  );
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

describe('GET /api/search — phrase match', () => {
  it('an "exact phrase" only matches notes where the words are adjacent, not just co-occurring', async () => {
    const nbId = insertNotebook('Algorithms');
    const adjacent = insertNote(nbId, 'BST note', 'Binary search trees provide O(log n) lookup for sorted data.');
    insertNote(nbId, 'Binary rep note', 'You can search in binary or decimal representations of these trees.');

    const res = await request(app).get('/api/search').query({ q: '"binary search"' });
    expect(res.status).toBe(200);
    expect(res.body.parsed).toEqual({ terms: [], phrases: ['binary search'], excluded: [], tag: null, notebook: null });
    expect(ids(res)).toEqual([adjacent]);
    expect(res.body.results[0].snippetHtml).toContain('<mark>');
  });
});

describe('GET /api/search — exclusion', () => {
  it('-word drops notes containing the excluded term', async () => {
    const nbId = insertNotebook('Algorithms');
    const keep = insertNote(nbId, 'Quicksort', 'Quicksort is a divide and conquer sorting algorithm.');
    insertNote(nbId, 'Merge sort', 'Merge sort is also a divide and conquer sorting algorithm but stable.');

    const res = await request(app).get('/api/search').query({ q: 'divide -merge' });
    expect(res.status).toBe(200);
    expect(res.body.parsed.excluded).toEqual(['merge']);
    expect(ids(res)).toEqual([keep]);
  });

  it('a bare exclusion with no positive criteria returns no results, never 500', async () => {
    const nbId = insertNotebook('Algorithms');
    insertNote(nbId, 'Note', 'Merge sort content.');

    const res = await request(app).get('/api/search').query({ q: '-merge' });
    expect(res.status).toBe(200);
    expect(res.body.parsed.excluded).toEqual(['merge']);
    expect(res.body.results).toEqual([]);
  });
});

describe('GET /api/search — tag filter', () => {
  it('tag:name filters to notes carrying that exact tag, with no text term required', async () => {
    const nbId = insertNotebook('Algorithms');
    const tagged = insertNote(nbId, 'Week 3 note', 'Balanced trees this week.');
    tagNote(tagged, 'week3');
    const untagged = insertNote(nbId, 'Other note', 'Balanced trees again.');
    void untagged;

    const res = await request(app).get('/api/search').query({ q: 'tag:week3' });
    expect(res.status).toBe(200);
    expect(res.body.parsed).toEqual({ terms: [], phrases: [], excluded: [], tag: 'week3', notebook: null });
    expect(ids(res)).toEqual([tagged]);
    // No FTS row backs this branch, so score falls back to 0 and the snippet is
    // the plain note snippet rather than a <mark>-highlighted FTS one.
    expect(res.body.results[0].score).toBe(0);
  });

  it('excludes archived notes from a tag-only browse', async () => {
    const nbId = insertNotebook('Algorithms');
    const archived = insertNote(nbId, 'Archived note', 'Old content.', { archived: 1 });
    tagNote(archived, 'week3');

    const res = await request(app).get('/api/search').query({ q: 'tag:week3' });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });
});

describe('GET /api/search — notebook filter', () => {
  it('notebook:name is a case-insensitive prefix match on the notebook name', async () => {
    const algo = insertNotebook('Algorithms & Data Structures');
    const db2 = insertNotebook('Databases');
    const inAlgo = insertNote(algo, 'Note A', 'Some content about complexity.');
    insertNote(db2, 'Note B', 'Some content about complexity.');

    const res = await request(app).get('/api/search').query({ q: 'notebook:algorithms' });
    expect(res.status).toBe(200);
    expect(res.body.parsed.notebook).toBe('algorithms');
    expect(ids(res)).toEqual([inAlgo]);
  });
});

describe('GET /api/search — combination', () => {
  it('tag: + a bareword term must both match (FTS branch honours the tag join)', async () => {
    const nbId = insertNotebook('Databases');
    const match = insertNote(nbId, 'Normalization', 'Normal forms reduce redundancy in relational database design.');
    tagNote(match, 'week1');
    const wrongTag = insertNote(nbId, 'Other normalization note', 'Redundancy elimination is part of relational design too.');
    void wrongTag;

    const res = await request(app).get('/api/search').query({ q: 'tag:week1 redundancy' });
    expect(res.status).toBe(200);
    expect(res.body.parsed.tag).toBe('week1');
    expect(res.body.parsed.terms).toEqual(['redundancy']);
    expect(ids(res)).toEqual([match]);
  });

  it('notebook: + phrase + exclusion compose correctly', async () => {
    const algo = insertNotebook('Algorithms & Data Structures');
    const other = insertNotebook('Databases');
    const want = insertNote(algo, 'Good', 'A binary search tree keeps its keys sorted for fast lookup.');
    insertNote(algo, 'Excluded by word', 'A binary search tree is unbalanced and slow today.');
    insertNote(other, 'Wrong notebook', 'A binary search tree keeps its keys sorted for fast lookup.');

    const res = await request(app).get('/api/search').query({ q: 'notebook:Algorithms "binary search tree" -unbalanced' });
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
    const res = await request(app).get('/api/search').query({ q });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.results)).toBe(true);
    expect(res.body.parsed).toBeTruthy();
  });

  it('really did not drop the notes table', async () => {
    const nbId = insertNotebook('Survives');
    insertNote(nbId, 'Still here', 'proof of life');
    await request(app).get('/api/search').query({ q: `'; DROP TABLE notes; --` });
    const res = await request(app).get('/api/search').query({ q: 'proof' });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
  });
});

describe('GET /api/search — empty', () => {
  it('missing q returns no results with an all-empty parsed echo', async () => {
    const res = await request(app).get('/api/search');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      results: [],
      parsed: { terms: [], phrases: [], excluded: [], tag: null, notebook: null },
    });
  });

  it('empty string q behaves the same as missing q', async () => {
    const res = await request(app).get('/api/search').query({ q: '' });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });

  it('whitespace-only q parses to nothing usable', async () => {
    const res = await request(app).get('/api/search').query({ q: '   ' });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });
});
