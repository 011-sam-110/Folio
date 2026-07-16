import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';

// The DB connection is opened at import time (server/src/db.ts reads FOLIO_DB_PATH via
// config.ts), so the env var must be set BEFORE anything that transitively imports it.
// Static `import` statements are hoisted above this, so we set the env var here and
// pull in the app modules with dynamic imports afterwards.
const dbPath = path.join(os.tmpdir(), `folio-data-test-${process.pid}-${Date.now()}.db`);
process.env.FOLIO_DB_PATH = dbPath;

const { db } = await import('../src/db.js');
const { buildApp } = await import('../src/app.js');

const app = buildApp();

async function createNotebook(name = 'Test Notebook') {
  const res = await request(app).post('/api/notebooks').send({ name });
  return res.body.notebook;
}

async function createNote(notebookId: string, overrides: Record<string, unknown> = {}) {
  const res = await request(app)
    .post('/api/notes')
    .send({ notebookId, title: 'Untitled', ...overrides });
  return res.body.note;
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

describe('Notebooks CRUD', () => {
  it('creates, lists, and returns notebooks ordered by position with stats', async () => {
    await createNotebook('Alpha');
    await createNotebook('Beta');
    const res = await request(app).get('/api/notebooks');
    expect(res.status).toBe(200);
    expect(res.body.notebooks).toHaveLength(2);
    expect(res.body.notebooks[0].name).toBe('Alpha');
    expect(res.body.notebooks[0]).toMatchObject({ noteCount: 0, lastNoteAt: null, archived: false });
  });

  it('rejects an empty name with 400', async () => {
    const res = await request(app).post('/api/notebooks').send({ name: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('patches a notebook and 404s for an unknown id', async () => {
    const nb = await createNotebook('Original');
    const res = await request(app).patch(`/api/notebooks/${nb.id}`).send({ name: 'Renamed', archived: true });
    expect(res.status).toBe(200);
    expect(res.body.notebook.name).toBe('Renamed');
    expect(res.body.notebook.archived).toBe(true);

    const missing = await request(app).patch('/api/notebooks/nope').send({ name: 'x' });
    expect(missing.status).toBe(404);
  });

  it('deletes a notebook and cascades its notes', async () => {
    const nb = await createNotebook('To delete');
    const note = await createNote(nb.id);

    const res = await request(app).delete(`/api/notebooks/${nb.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const noteRes = await request(app).get(`/api/notes/${note.id}`);
    expect(noteRes.status).toBe(404);
  });
});

describe('Notes CRUD + tags', () => {
  it('creates a note with tags and returns NoteLite-shaped fields', async () => {
    const nb = await createNotebook();
    const res = await request(app).post('/api/notes').send({ notebookId: nb.id, title: 'My Note', tags: ['week1', 'lecture'] });
    expect(res.status).toBe(201);
    expect(res.body.note.title).toBe('My Note');
    expect([...res.body.note.tags].sort()).toEqual(['lecture', 'week1']);
    expect(res.body.note.notebook.id).toBe(nb.id);
  });

  it('400s creating a note with an unknown notebookId', async () => {
    const res = await request(app).post('/api/notes').send({ notebookId: 'does-not-exist' });
    expect(res.status).toBe(400);
  });

  it('lists notes filtered by notebookId and tag, respecting the archived flag', async () => {
    const nb = await createNotebook();
    const a = await createNote(nb.id, { title: 'A', tags: ['week1'] });
    await createNote(nb.id, { title: 'B', tags: ['week2'] });
    await request(app).patch(`/api/notes/${a.id}`).send({ archived: true });

    const activeRes = await request(app).get(`/api/notes?notebookId=${nb.id}`);
    expect(activeRes.body.total).toBe(1);
    expect(activeRes.body.notes[0].title).toBe('B');

    const archivedRes = await request(app).get(`/api/notes?notebookId=${nb.id}&archived=1`);
    expect(archivedRes.body.total).toBe(1);
    expect(archivedRes.body.notes[0].title).toBe('A');

    const tagRes = await request(app).get('/api/notes?tag=week2');
    expect(tagRes.body.total).toBe(1);
    expect(tagRes.body.notes[0].title).toBe('B');
  });

  it('updates a note (title/pinned) via PATCH', async () => {
    const nb = await createNotebook();
    const note = await createNote(nb.id);
    const res = await request(app).patch(`/api/notes/${note.id}`).send({ title: 'Updated title', pinned: true });
    expect(res.status).toBe(200);
    expect(res.body.note.title).toBe('Updated title');
    expect(res.body.note.pinned).toBe(true);
  });

  it('404s GET/PATCH/DELETE for an unknown note', async () => {
    expect((await request(app).get('/api/notes/nope')).status).toBe(404);
    expect((await request(app).patch('/api/notes/nope').send({ title: 'x' })).status).toBe(404);
    expect((await request(app).delete('/api/notes/nope')).status).toBe(404);
  });

  it('deletes a note', async () => {
    const nb = await createNotebook();
    const note = await createNote(nb.id);
    const res = await request(app).delete(`/api/notes/${note.id}`);
    expect(res.status).toBe(200);
    expect((await request(app).get(`/api/notes/${note.id}`)).status).toBe(404);
  });

  it('recent notes excludes archived and orders by updatedAt desc', async () => {
    const nb = await createNotebook();
    const a = await createNote(nb.id, { title: 'Old' });
    const b = await createNote(nb.id, { title: 'Middle' });
    const c = await createNote(nb.id, { title: 'New' });
    db.prepare('UPDATE notes SET updated_at = ? WHERE id = ?').run(new Date(Date.now() - 3000).toISOString(), a.id);
    db.prepare('UPDATE notes SET updated_at = ? WHERE id = ?').run(new Date(Date.now() - 2000).toISOString(), b.id);
    db.prepare('UPDATE notes SET updated_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), c.id);
    await request(app).patch(`/api/notes/${a.id}`).send({ archived: true });

    const res = await request(app).get('/api/notes/recent');
    const ids = res.body.notes.map((n: { id: string }) => n.id);
    expect(ids).not.toContain(a.id);
    expect(ids.indexOf(c.id)).toBeLessThan(ids.indexOf(b.id));
  });
});

describe('Version snapshot policy', () => {
  it('creates an autosave version (capturing pre-edit state) on the first content-changing PATCH', async () => {
    const nb = await createNotebook();
    const note = await createNote(nb.id, { title: 'V1' });

    await request(app).patch(`/api/notes/${note.id}`).send({ title: 'V2' });

    const versions = await request(app).get(`/api/notes/${note.id}/versions`);
    expect(versions.body.versions).toHaveLength(1);
    expect(versions.body.versions[0].cause).toBe('autosave');
    expect(versions.body.versions[0].title).toBe('V1');
  });

  it('does not snapshot again within the 10-minute autosave window', async () => {
    const nb = await createNotebook();
    const note = await createNote(nb.id, { title: 'V1' });
    await request(app).patch(`/api/notes/${note.id}`).send({ title: 'V2' });
    await request(app).patch(`/api/notes/${note.id}`).send({ title: 'V3' });

    const versions = await request(app).get(`/api/notes/${note.id}/versions`);
    expect(versions.body.versions).toHaveLength(1);
  });

  it('snapshots again once the latest version is older than 10 minutes', async () => {
    const nb = await createNotebook();
    const note = await createNote(nb.id, { title: 'V1' });
    await request(app).patch(`/api/notes/${note.id}`).send({ title: 'V2' });

    db.prepare('UPDATE note_versions SET created_at = ? WHERE note_id = ?').run(
      new Date(Date.now() - 11 * 60_000).toISOString(),
      note.id,
    );

    await request(app).patch(`/api/notes/${note.id}`).send({ title: 'V3' });

    const versions = await request(app).get(`/api/notes/${note.id}/versions`);
    expect(versions.body.versions).toHaveLength(2);
  });

  it('POST /versions always creates a manual snapshot, and restore snapshots current state first', async () => {
    const nb = await createNotebook();
    const note = await createNote(nb.id, { title: 'Original' });

    const snap = await request(app).post(`/api/notes/${note.id}/versions`).send({ label: 'Checkpoint' });
    expect(snap.status).toBe(201);
    expect(snap.body.version.cause).toBe('manual');
    expect(snap.body.version.label).toBe('Checkpoint');

    await request(app).patch(`/api/notes/${note.id}`).send({ title: 'Changed' });

    const restore = await request(app).post(`/api/notes/${note.id}/restore/${snap.body.version.id}`);
    expect(restore.status).toBe(200);
    expect(restore.body.note.title).toBe('Original');

    const versions = await request(app).get(`/api/notes/${note.id}/versions`);
    const causes = versions.body.versions.map((v: { cause: string }) => v.cause);
    expect(causes).toContain('restore');
  });

  it('404s restoring an unknown version', async () => {
    const nb = await createNotebook();
    const note = await createNote(nb.id);
    const res = await request(app).post(`/api/notes/${note.id}/restore/999999`);
    expect(res.status).toBe(404);
  });
});

describe('Wikilinks and backlinks', () => {
  it('extracts [[wikilinks]] into links, resolving titles case-insensitively', async () => {
    const nb = await createNotebook();
    const target = await createNote(nb.id, { title: 'Big O Notation' });
    const source = await createNote(nb.id, { title: 'Sorting Algorithms', contentText: 'See [[big o notation]] for background.' });

    const detail = await request(app).get(`/api/notes/${source.id}`);
    expect(detail.body.outgoingLinks.map((n: { id: string }) => n.id)).toContain(target.id);

    const targetDetail = await request(app).get(`/api/notes/${target.id}`);
    expect(targetDetail.body.backlinks.map((n: { id: string }) => n.id)).toContain(source.id);
  });

  it('replaces links on re-save rather than accumulating them', async () => {
    const nb = await createNotebook();
    const a = await createNote(nb.id, { title: 'Note A' });
    const b = await createNote(nb.id, { title: 'Note B' });
    const source = await createNote(nb.id, { title: 'Source', contentText: 'Links to [[Note A]].' });

    await request(app).patch(`/api/notes/${source.id}`).send({ contentText: 'Now links to [[Note B]] instead.' });

    const detail = await request(app).get(`/api/notes/${source.id}`);
    const ids = detail.body.outgoingLinks.map((n: { id: string }) => n.id);
    expect(ids).toContain(b.id);
    expect(ids).not.toContain(a.id);
  });

  it('unlinked-mentions finds a plain-text title mention that is not yet linked', async () => {
    const nb = await createNotebook();
    const target = await createNote(nb.id, { title: 'Deadlock' });
    const mentioning = await createNote(nb.id, { title: 'OS Revision', contentText: 'Remember to revise deadlock before the exam.' });

    const res = await request(app).get(`/api/notes/${target.id}/unlinked-mentions`);
    expect(res.status).toBe(200);
    expect(res.body.notes.map((n: { id: string }) => n.id)).toContain(mentioning.id);
  });
});

describe('Search', () => {
  it('returns a bm25-ranked, highlighted snippet for a matching query', async () => {
    const nb = await createNotebook();
    await createNote(nb.id, { title: 'Big-O Notation', contentText: 'Big-O notation describes algorithmic complexity growth.' });

    const res = await request(app).get('/api/search?q=complexity');
    expect(res.status).toBe(200);
    expect(res.body.results.length).toBeGreaterThan(0);
    expect(res.body.results[0].snippetHtml).toContain('<mark>');
    expect(res.body.results[0].note.title).toBe('Big-O Notation');
  });

  it('never 500s on hostile queries', async () => {
    const nb = await createNotebook();
    await createNote(nb.id, { title: 'Note', contentText: 'some content' });

    const queries = ["it's", 'AND', '***', '"unbalanced', '🔥🔥🔥', '   ', 'a"b\'c', 'NEAR OR NOT'];
    for (const q of queries) {
      const res = await request(app).get(`/api/search?q=${encodeURIComponent(q)}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.results)).toBe(true);
    }
  });

  it('empty query returns empty results, not an error', async () => {
    const res = await request(app).get('/api/search?q=');
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });

  it('search/titles does contains matching for the quick switcher', async () => {
    const nb = await createNotebook();
    await createNote(nb.id, { title: 'Operating Systems Revision' });
    await createNote(nb.id, { title: 'Notes about Operating room procedures' });

    const res = await request(app).get('/api/search/titles?q=Operating');
    expect(res.status).toBe(200);
    expect(res.body.results.length).toBe(2);
    expect(res.body.results[0].notebook).toHaveProperty('id');
  });
});

describe('Tags', () => {
  it('lists tags ordered by count desc', async () => {
    const nb = await createNotebook();
    await createNote(nb.id, { tags: ['week1', 'lecture'] });
    await createNote(nb.id, { tags: ['week1'] });

    const res = await request(app).get('/api/tags');
    expect(res.status).toBe(200);
    expect(res.body.tags[0]).toEqual({ tag: 'week1', count: 2 });
  });
});

describe('Dashboard', () => {
  it('returns the full aggregated dashboard shape', async () => {
    const nb = await createNotebook('Algorithms');
    const note = await createNote(nb.id, { title: 'Pinned note' });
    await request(app).patch(`/api/notes/${note.id}`).send({ pinned: true });

    const res = await request(app).get('/api/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.stats).toMatchObject({ notes: 1, notebooks: 1 });
    expect(res.body.stats).toHaveProperty('words');
    expect(res.body.stats).toHaveProperty('flashcardsDue');
    expect(res.body.weekActivity).toHaveLength(14);
    expect(res.body.pinned.map((n: { id: string }) => n.id)).toContain(note.id);
    expect(res.body.continueNote.id).toBe(note.id);
    expect(res.body.notebooks[0].id).toBe(nb.id);
  });
});

describe('Export', () => {
  it('exports a note as Markdown containing its heading and body text', async () => {
    const nb = await createNotebook();
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Exported Heading' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Some body text.' }] },
      ],
    };
    const note = await createNote(nb.id, { title: 'Export Me', contentJson: doc, contentText: 'Exported Heading Some body text.' });

    const res = await request(app).get(`/api/notes/${note.id}/export?format=markdown`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.text).toContain('# Exported Heading');
    expect(res.text).toContain('Some body text.');
  });

  it('400s for an unsupported export format', async () => {
    const nb = await createNotebook();
    const note = await createNote(nb.id);
    const res = await request(app).get(`/api/notes/${note.id}/export?format=pdf`);
    expect(res.status).toBe(400);
  });
});
