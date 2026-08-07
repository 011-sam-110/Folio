import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { unzipSync, strFromU8 } from 'fflate';
import { buildApp } from '../src/app.js';
import { db, newId, nowIso } from '../src/db.js';
import { canvasMarkdown, frontmatter, safeName, MAX_NOTES } from '../src/routes/export.js';
import { resetDatabase, resetData, makeUser, insertNotebook, insertNote, closeDatabase, type TestUser } from './helpers.js';

// Built through the real app: /api/export is mounted behind requireAuth in app.ts, and a
// bare router mount would skip the guard that `userId(req)` reads its owner from.
const app = buildApp();

let user: TestUser;
let api: TestUser['agent'];

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

/**
 * Download the archive as raw bytes.
 *
 * supertest parses a response by content-type, and it has no parser for application/zip -
 * left alone it hands back a string that has already been through utf-8 decoding, which
 * corrupts the compressed bytes and makes every assertion below fail for the wrong reason.
 */
async function downloadZip(agent: TestUser['agent'], path = '/api/export/all') {
  return agent
    .get(path)
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
}

/** The zip a download produced, as { path: text }. */
function readArchive(body: Buffer): Record<string, string> {
  const entries = unzipSync(new Uint8Array(body));
  return Object.fromEntries(Object.entries(entries).map(([path, bytes]) => [path, strFromU8(bytes)]));
}

const doc = (text: string) =>
  JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

async function addTag(noteId: string, tag: string): Promise<void> {
  await db.prepare('INSERT INTO note_tags (note_id, tag) VALUES (?, ?) ON CONFLICT DO NOTHING').run(noteId, tag);
}

describe('GET /api/export/all', () => {
  it('is refused without a session', async () => {
    const res = await request(app).get('/api/export/all');
    expect(res.status).toBe(401);
  });

  it('returns a zip with one Markdown file per note, foldered by notebook', async () => {
    const nb = await insertNotebook(user.id, { name: 'Databases' });
    await insertNote(user.id, nb, { title: 'Indexing', content_json: doc('B-trees keep reads cheap.') });
    await insertNote(user.id, nb, { title: 'Normalisation', content_json: doc('Third normal form.') });

    const res = await downloadZip(api);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/zip');
    expect(res.headers['content-disposition']).toContain('.zip');
    expect(res.headers['x-unote-export-notes']).toBe('2');
    expect(res.headers['x-unote-export-omitted']).toBe('0');

    const files = readArchive(res.body as Buffer);
    expect(Object.keys(files).sort()).toEqual(['Databases/Indexing.md', 'Databases/Normalisation.md', 'README.md']);
    expect(files['Databases/Indexing.md']).toContain('B-trees keep reads cheap.');
    expect(files['README.md']).toContain('Everything in your account is here.');
  });

  it('writes a frontmatter block the import wizard can read back', async () => {
    const nb = await insertNotebook(user.id, { name: 'Physics' });
    const noteId = await insertNote(user.id, nb, { title: 'Waves', content_json: doc('Superposition.') });
    await addTag(noteId, 'revision');
    await addTag(noteId, 'term1');

    const files = readArchive((await downloadZip(api)).body as Buffer);
    const body = files['Physics/Waves.md'];
    expect(body.startsWith('---\n')).toBe(true);
    expect(body).toContain('title: Waves');
    expect(body).toContain('notebook: Physics');
    // The wizard's parser reads an inline list, so the shape matters and not just the values.
    expect(body).toMatch(/^tags: \[(revision, term1|term1, revision)\]$/m);
  });

  it("never includes another account's notes", async () => {
    const mine = await insertNotebook(user.id, { name: 'Mine' });
    await insertNote(user.id, mine, { title: 'My note', content_json: doc('mine') });

    const other = await makeUser(app);
    const theirs = await insertNotebook(other.id, { name: 'Theirs' });
    await insertNote(other.id, theirs, { title: 'Their note', content_json: doc('secret') });

    const files = readArchive((await downloadZip(api)).body as Buffer);
    expect(Object.keys(files)).not.toContain('Theirs/Their note.md');
    expect(Object.values(files).join('\n')).not.toContain('secret');
    expect(Object.values(files).join('\n')).toContain('mine');
  });

  it('leaves trashed notes out', async () => {
    const nb = await insertNotebook(user.id, { name: 'Notes' });
    await insertNote(user.id, nb, { title: 'Kept', content_json: doc('kept') });
    await insertNote(user.id, nb, { title: 'Binned', content_json: doc('binned'), deleted_at: nowIso() });

    const files = readArchive((await downloadZip(api)).body as Buffer);
    expect(Object.keys(files)).toContain('Notes/Kept.md');
    expect(Object.keys(files)).not.toContain('Notes/Binned.md');
  });

  it('gives two same-titled notes two different paths', async () => {
    const nb = await insertNotebook(user.id, { name: 'Notes' });
    await insertNote(user.id, nb, { title: 'Lecture', content_json: doc('first') });
    await insertNote(user.id, nb, { title: 'Lecture', content_json: doc('second') });

    const paths = Object.keys(readArchive((await downloadZip(api)).body as Buffer)).filter((p) => p !== 'README.md');
    expect(paths).toHaveLength(2);
    expect(new Set(paths).size).toBe(2);
  });

  it('exports a board as its text, and says what is missing', async () => {
    const nb = await insertNotebook(user.id, { name: 'Boards' });
    const boardId = newId();
    await db
      .prepare(
        `INSERT INTO notes (id, user_id, notebook_id, title, content_json, content_text, kind, created_at, updated_at)
         VALUES (?, ?, ?, ?, '{"type":"doc","content":[]}', '', 'canvas', ?, ?)`,
      )
      .run(boardId, user.id, nb, 'Plan', nowIso(), nowIso());
    await db
      .prepare('INSERT INTO canvas_items (id, note_id, kind, data) VALUES (?, ?, ?, ?)')
      .run(newId(), boardId, 'sticky', JSON.stringify({ text: 'Book the lab' }));

    const body = readArchive((await downloadZip(api)).body as Buffer)['Boards/Plan.md'];
    expect(body).toContain('Book the lab');
    expect(body).toContain('positions, arrows and drawings are not part of a Markdown export');
  });

  it('rejects a format it cannot produce', async () => {
    const res = await api.get('/api/export/all?format=pdf');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/export/summary', () => {
  it("counts only the caller's live notes and names the cap", async () => {
    const nb = await insertNotebook(user.id, { name: 'Mine' });
    await insertNote(user.id, nb, { title: 'One' });
    await insertNote(user.id, nb, { title: 'Two' });
    await insertNote(user.id, nb, { title: 'Gone', deleted_at: nowIso() });

    const other = await makeUser(app);
    const theirs = await insertNotebook(other.id, { name: 'Theirs' });
    await insertNote(other.id, theirs, { title: 'Not mine' });

    const res = await api.get('/api/export/summary');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ notes: 2, notebooks: 1, included: 2, truncated: false, maxNotes: MAX_NOTES });
  });

  it('is refused without a session', async () => {
    const res = await request(app).get('/api/export/summary');
    expect(res.status).toBe(401);
  });
});

describe('export helpers', () => {
  it('strips path separators out of a name so a title cannot escape its folder', () => {
    expect(safeName('Week 1/2: intro', 'untitled')).toBe('Week 1 2 intro');
    expect(safeName('../../etc/passwd', 'untitled')).toBe('.. .. etc passwd');
    expect(safeName('   ', 'untitled')).toBe('untitled');
  });

  it('omits the tags line entirely when a note has none', () => {
    const out = frontmatter({ title: 'A', updatedAt: '2026-01-01T00:00:00Z', tags: [] }, 'Notes');
    expect(out).not.toContain('tags:');
    expect(out).toContain('title: A');
  });

  it('says so when a board has no text at all', () => {
    expect(canvasMarkdown([])).toContain('no text on it');
  });
});
