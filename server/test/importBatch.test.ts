// Bulk "Import old notes" wizard: staging -> categorise -> commit.
//
// The load-bearing guarantee is that NOTHING reaches a real notebook until commit, and that
// commit uses no AI. These tests stage a handful of fake md/txt files across two "folders",
// assert they stage and can be categorised, prove no note exists until commit, then commit and
// check the notes land in the right notebooks with the right tags. Cross-tenant isolation and
// discard-cleanup are checked too.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { db } from '../src/db.js';
import { resetDatabase, resetData, makeUser, closeDatabase, insertNotebook, insertNote, type TestUser } from './helpers.js';

const app = buildApp();

let alice: TestUser;
let bob: TestUser;

async function noteCount(uid: string): Promise<number> {
  const r = await db.prepare('SELECT COUNT(*) as c FROM notes WHERE user_id = ? AND deleted_at IS NULL').get<{ c: number }>(uid);
  return Number(r?.c ?? 0);
}

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

describe('bulk import: staging never touches real notebooks until commit', () => {
  it('stages, categorises and commits a folder of notes into the right notebooks + tags', async () => {
    // A pre-existing notebook with a note, so the label space has a real term profile.
    const dbNb = await insertNotebook(alice.id, { name: 'Databases' });
    await insertNote(alice.id, dbNb, {
      title: 'Indexing basics',
      content_text: 'A b-tree index speeds up lookups on a database table by key. Indexes cost space.',
    });
    const before = await noteCount(alice.id); // 1

    // 1) create a batch
    const batchRes = await alice.agent.post('/api/import/batches').send({ source: 'markdown' });
    expect(batchRes.status).toBe(201);
    const batchId = batchRes.body.batchId as string;
    expect(batchId).toBeTruthy();

    // 2) stage three text items across two folders + one loose file
    const stageRes = await alice.agent.post(`/api/import/batches/${batchId}/items`).send({
      items: [
        { originalName: 'indexing.md', sourcePath: 'databases/indexing.md', text: '# B-Trees and indexing\n\nA b-tree index over a database table.', sourceTags: ['databases', 'indexing'] },
        { originalName: 'scheduling.md', sourcePath: 'os/scheduling.md', text: '# Scheduling\n\nRound robin and the operating system scheduler.' },
        { originalName: 'misc.txt', text: 'Some loose thoughts with no folder and no clear topic.' },
      ],
    });
    expect(stageRes.status).toBe(201);
    const staged = stageRes.body.items as Array<{ id: string; status: string; wordCount: number; sourceTags: string[]; kind: string }>;
    expect(staged).toHaveLength(3);
    expect(staged.every((i) => i.status === 'ready')).toBe(true);
    expect(staged[0].wordCount).toBeGreaterThan(0);
    expect(staged[0].sourceTags).toEqual(['databases', 'indexing']);

    // Real notebooks are untouched: no note created by staging.
    expect(await noteCount(alice.id)).toBe(before);

    // 3) label space feeds the (client) heuristic — the Databases profile has real terms
    const ls = await alice.agent.get('/api/import/label-space');
    expect(ls.status).toBe(200);
    expect(ls.body.notebooks.map((n: { name: string }) => n.name)).toContain('Databases');
    expect(Object.keys(ls.body.profiles)).toContain(dbNb);
    expect(Object.keys(ls.body.profiles[dbNb]).length).toBeGreaterThan(0);

    // 4) persist the categoriser's suggestions (heuristic ran client-side)
    const [it0, it1, it2] = staged;
    const catRes = await alice.agent.post(`/api/import/batches/${batchId}/categorise`).send({
      categoriser: 'heuristic',
      suggestions: [
        { itemId: it0.id, notebook: { kind: 'existing', id: dbNb }, tags: ['databases', 'indexing'], confidence: 0.9, rationale: 'matched folder "databases"' },
        { itemId: it1.id, notebook: { kind: 'new', name: 'Operating Systems' }, tags: ['os'], confidence: 0.8, rationale: 'folder "os"' },
        { itemId: it2.id, notebook: { kind: 'new', name: 'Unsorted' }, tags: [], confidence: 0.1, rationale: 'no clear signal' },
      ],
    });
    expect(catRes.status).toBe(200);
    expect(catRes.body.categoriser).toBe('heuristic');
    const cat0 = catRes.body.items.find((i: { id: string }) => i.id === it0.id);
    expect(cat0.suggestedNotebookId).toBe(dbNb);
    expect(cat0.status).toBe('categorised');
    // decision defaults mirror the suggestion
    expect(cat0.decidedNotebookId).toBe(dbNb);

    // Still nothing in real notebooks after categorising.
    expect(await noteCount(alice.id)).toBe(before);

    // 5) a user edit via PATCH (rename tags on item 1)
    const patchRes = await alice.agent.patch(`/api/import/batches/${batchId}/items/${it1.id}`).send({ decidedTags: ['operating-systems'], status: 'accepted' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.item.decidedTags).toEqual(['operating-systems']);

    // 6) commit everything
    const commitRes = await alice.agent.post(`/api/import/batches/${batchId}/commit`).send({ itemIds: [it0.id, it1.id, it2.id] });
    expect(commitRes.status).toBe(200);
    expect(commitRes.body.created).toBe(3);
    expect(commitRes.body.batchStatus).toBe('committed');
    const newNbNames = commitRes.body.createdNotebooks.map((n: { name: string }) => n.name);
    expect(newNbNames).toContain('Operating Systems');
    expect(newNbNames).toContain('Unsorted');

    // Now — and only now — the notes exist.
    expect(await noteCount(alice.id)).toBe(before + 3);

    // item 0 landed in the existing Databases notebook, with its tags
    const committed0 = commitRes.body.items.find((i: { id: string }) => i.id === it0.id);
    const note0 = await db.prepare('SELECT notebook_id, title FROM notes WHERE id = ?').get<{ notebook_id: string; title: string }>(committed0.noteId);
    expect(note0?.notebook_id).toBe(dbNb);
    expect(note0?.title).toBe('B-Trees and indexing');
    const tags0 = await db.prepare('SELECT tag FROM note_tags WHERE note_id = ? ORDER BY tag').all<{ tag: string }>(committed0.noteId);
    expect(tags0.map((t) => t.tag)).toEqual(['databases', 'indexing']);

    // item 1 landed in the newly-created "Operating Systems" notebook, with the edited tag
    const committed1 = commitRes.body.items.find((i: { id: string }) => i.id === it1.id);
    const note1 = await db.prepare('SELECT n.notebook_id, nb.name FROM notes n JOIN notebooks nb ON nb.id = n.notebook_id WHERE n.id = ?').get<{ notebook_id: string; name: string }>(committed1.noteId);
    expect(note1?.name).toBe('Operating Systems');
    const tags1 = await db.prepare('SELECT tag FROM note_tags WHERE note_id = ?').all<{ tag: string }>(committed1.noteId);
    expect(tags1.map((t) => t.tag)).toEqual(['operating-systems']);
  });

  it('is idempotent: re-committing a chunk creates no duplicate notes', async () => {
    const nb = await insertNotebook(alice.id, { name: 'Notes' });
    const before = await noteCount(alice.id);
    const { body: b } = await alice.agent.post('/api/import/batches').send({ source: 'files' });
    const batchId = b.batchId as string;
    const { body: s } = await alice.agent.post(`/api/import/batches/${batchId}/items`).send({
      items: [{ originalName: 'a.md', text: '# A\n\nbody', sourcePath: 'notes/a.md' }],
    });
    const itemId = s.items[0].id as string;
    await alice.agent.post(`/api/import/batches/${batchId}/categorise`).send({
      categoriser: 'heuristic',
      suggestions: [{ itemId, notebook: { kind: 'existing', id: nb }, tags: [], confidence: 0.9 }],
    });
    const first = await alice.agent.post(`/api/import/batches/${batchId}/commit`).send({ itemIds: [itemId] });
    expect(first.body.created).toBe(1);
    expect(await noteCount(alice.id)).toBe(before + 1);

    const second = await alice.agent.post(`/api/import/batches/${batchId}/commit`).send({ itemIds: [itemId] });
    expect(second.body.created).toBe(0);
    expect(second.body.skipped).toBe(1);
    expect(await noteCount(alice.id)).toBe(before + 1); // no duplicate
  });

  it('stages a photo (multipart) with OCR text and files the image on commit', async () => {
    // 1x1 transparent PNG.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const nb = await insertNotebook(alice.id, { name: 'Scans' });
    const { body: b } = await alice.agent.post('/api/import/batches').send({ source: 'photos' });
    const batchId = b.batchId as string;

    const stage = await alice.agent
      .post(`/api/import/batches/${batchId}/items`)
      .field('kind', 'photo')
      .field('ocrText', 'handwritten lecture notes about vectors')
      .field('sourcePath', 'photos/scan.png')
      .attach('file', png, { filename: 'scan.png', contentType: 'image/png' });
    expect(stage.status).toBe(201);
    expect(stage.body.item.kind).toBe('photo');
    expect(stage.body.item.imageUrl).toMatch(/^\/uploads\//);
    expect(stage.body.item.attachmentId).toBeTruthy();
    const itemId = stage.body.item.id as string;

    // the staged attachment exists but is filed against no note yet
    const att = await db.prepare('SELECT note_id FROM attachments WHERE id = ?').get<{ note_id: string | null }>(stage.body.item.attachmentId);
    expect(att?.note_id).toBeNull();

    await alice.agent.post(`/api/import/batches/${batchId}/categorise`).send({
      categoriser: 'heuristic',
      suggestions: [{ itemId, notebook: { kind: 'existing', id: nb }, tags: ['vectors'], confidence: 0.6 }],
    });
    const commit = await alice.agent.post(`/api/import/batches/${batchId}/commit`).send({ itemIds: [itemId] });
    expect(commit.body.created).toBe(1);
    const noteId = commit.body.items[0].noteId as string;

    // the note body embeds the image URL, and the attachment is now filed against the note
    const note = await db.prepare('SELECT content_json FROM notes WHERE id = ?').get<{ content_json: string }>(noteId);
    expect(note?.content_json).toContain('/uploads/');
    const att2 = await db.prepare('SELECT note_id FROM attachments WHERE id = ?').get<{ note_id: string | null }>(stage.body.item.attachmentId);
    expect(att2?.note_id).toBe(noteId);
  });

  it('discarding a batch removes staged photo attachments and creates no notes', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const before = await noteCount(alice.id);
    const { body: b } = await alice.agent.post('/api/import/batches').send({ source: 'photos' });
    const batchId = b.batchId as string;
    const stage = await alice.agent
      .post(`/api/import/batches/${batchId}/items`)
      .field('kind', 'photo')
      .attach('file', png, { filename: 'x.png', contentType: 'image/png' });
    const attachmentId = stage.body.item.attachmentId as string;

    const del = await alice.agent.delete(`/api/import/batches/${batchId}`);
    expect(del.status).toBe(200);
    expect((await alice.agent.get(`/api/import/batches/${batchId}`)).status).toBe(404);
    const att = await db.prepare('SELECT id FROM attachments WHERE id = ?').get<{ id: string }>(attachmentId);
    expect(att).toBeUndefined(); // orphan bytes cleaned up
    expect(await noteCount(alice.id)).toBe(before);
  });
});

describe('bulk import is owner-scoped', () => {
  it("does not let another account read, stage into, categorise, commit or discard a batch", async () => {
    const { body: b } = await alice.agent.post('/api/import/batches').send({ source: 'files' });
    const batchId = b.batchId as string;

    expect((await bob.agent.get(`/api/import/batches/${batchId}`)).status).toBe(404);
    expect((await bob.agent.post(`/api/import/batches/${batchId}/items`).send({ items: [{ originalName: 'x.md', text: 'hi' }] })).status).toBe(404);
    expect((await bob.agent.post(`/api/import/batches/${batchId}/categorise`).send({ categoriser: 'heuristic', suggestions: [] })).status).toBe(404);
    expect((await bob.agent.post(`/api/import/batches/${batchId}/commit`).send({ itemIds: ['whatever'] })).status).toBe(404);
    expect((await bob.agent.delete(`/api/import/batches/${batchId}`)).status).toBe(404);

    // alice's batch is intact and empty
    const mine = await alice.agent.get(`/api/import/batches/${batchId}`);
    expect(mine.status).toBe(200);
    expect(mine.body.items).toHaveLength(0);
  });

  it('refuses to categorise an item into another account notebook', async () => {
    const aliceNb = await insertNotebook(alice.id, { name: 'Private' });
    const { body: b } = await bob.agent.post('/api/import/batches').send({ source: 'files' });
    const batchId = b.batchId as string;
    const { body: s } = await bob.agent.post(`/api/import/batches/${batchId}/items`).send({ items: [{ originalName: 'x.md', text: 'hi' }] });
    const itemId = s.items[0].id as string;
    // Suggest bob's item into alice's notebook — must be ignored, not accepted.
    await bob.agent.post(`/api/import/batches/${batchId}/categorise`).send({
      categoriser: 'heuristic',
      suggestions: [{ itemId, notebook: { kind: 'existing', id: aliceNb }, tags: [], confidence: 0.9 }],
    });
    const view = await bob.agent.get(`/api/import/batches/${batchId}`);
    expect(view.body.items[0].suggestedNotebookId).toBeNull();
  });
});
