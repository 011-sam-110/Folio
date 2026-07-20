// Attachment storage and serving.
//
// The bug these cover: uploads were written to data/uploads/ with multer.diskStorage, which
// is a read-only path on the deployed serverless host — every import in production failed
// with EROFS before any of the logic below ran. Payloads now live in attachments.bytes and
// are served from there, so these tests assert the two halves of that: the write puts real
// bytes in the row, and the read hands them back to the right people and nobody else.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import { buildApp } from '../src/app.js';
import { db } from '../src/db.js';
import { insertAttachment, withTempFile, attachmentUrl } from '../src/lib/attachments.js';
import { figuresMarkdown, isPptx } from '../src/routes/imports.js';
import { markdownToTipTap } from '../src/lib/markdown.js';
import {
  resetDatabase,
  resetData,
  makeUser,
  closeDatabase,
  insertNotebook,
  insertNote,
  type TestUser,
} from './helpers.js';

const app = buildApp();

// A real 1x1 PNG, so Content-Type assertions are about actual image bytes.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

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

/** Store an attachment for `user` and return the URL it is served at. */
async function store(
  user: TestUser,
  opts: { noteId?: string | null; mime?: string; bytes?: Buffer; storedName?: string } = {},
): Promise<{ url: string; storedName: string; id: string }> {
  const storedName = opts.storedName ?? `att${Math.random().toString(36).slice(2, 10)}.png`;
  const id = await insertAttachment({
    uid: user.id,
    noteId: opts.noteId ?? null,
    kind: 'image',
    originalName: 'figure.png',
    storedName,
    mime: opts.mime ?? 'image/png',
    bytes: opts.bytes ?? PNG,
    status: 'ready',
  });
  return { url: attachmentUrl(storedName), storedName, id };
}

describe('attachment storage', () => {
  it('writes the payload into attachments.bytes rather than the filesystem', async () => {
    const { id } = await store(alice);
    const row = await db
      .prepare('SELECT bytes, size FROM attachments WHERE id = ?')
      .get<{ bytes: Buffer; size: number }>(id);
    expect(row?.bytes).toBeInstanceOf(Buffer);
    expect(Buffer.from(row!.bytes).equals(PNG)).toBe(true);
    expect(Number(row?.size)).toBe(PNG.byteLength);
  });

  it('POST /api/import/image stores the bytes and returns a resolvable /uploads URL', async () => {
    const res = await alice.agent
      .post('/api/import/image')
      .attach('file', PNG, { filename: 'shot.png', contentType: 'image/png' })
      .expect(200);

    expect(res.body.url).toMatch(/^\/uploads\/[a-z0-9]+\.png$/);

    // The URL is only meaningful if it actually serves the bytes back.
    const got = await alice.agent.get(res.body.url).expect(200);
    expect(got.headers['content-type']).toContain('image/png');
    expect(Buffer.from(got.body).equals(PNG)).toBe(true);
  });

  it('rejects a non-image on the editor image route', async () => {
    await alice.agent
      .post('/api/import/image')
      .attach('file', Buffer.from('not an image'), { filename: 'x.txt', contentType: 'text/plain' })
      .expect(400);
  });

  it('POST /api/import persists the upload into the row before responding', async () => {
    const notebookId = await insertNotebook(alice.id);
    const body = Buffer.from('Lecture one. Cells have mitochondria.\n');

    const res = await alice.agent
      .post('/api/import')
      .field('kind', 'transcript')
      .field('mode', 'new')
      .field('notebookId', notebookId)
      .attach('file', body, { filename: 'lecture.txt', contentType: 'text/plain' })
      .expect(200);

    expect(res.body.jobId).toBeTruthy();

    // This is the assertion the EROFS bug would have failed: on the old code path the
    // request never got this far, because multer tried to write to a read-only disk.
    const row = await db
      .prepare("SELECT bytes, mime, stored_name FROM attachments WHERE user_id = ? AND kind = 'transcript'")
      .get<{ bytes: Buffer; mime: string; stored_name: string }>(alice.id);
    expect(row).toBeTruthy();
    expect(Buffer.from(row!.bytes).equals(body)).toBe(true);
    expect(row!.stored_name).toMatch(/\.txt$/);
  });
});

describe('serving attachments', () => {
  it('returns the bytes with content type, length, cache headers and an ETag', async () => {
    const { url } = await store(alice, { mime: 'image/png' });
    const res = await alice.agent.get(url).expect(200);

    expect(res.headers['content-type']).toContain('image/png');
    expect(res.headers['content-length']).toBe(String(PNG.byteLength));
    expect(res.headers['cache-control']).toContain('max-age');
    expect(res.headers['etag']).toBeTruthy();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.from(res.body).equals(PNG)).toBe(true);
  });

  it('honours If-None-Match with a 304', async () => {
    const { url } = await store(alice);
    const first = await alice.agent.get(url).expect(200);
    await alice.agent.get(url).set('If-None-Match', first.headers['etag']).expect(304);
  });

  it('404s for an attachment that does not exist', async () => {
    await alice.agent.get('/uploads/doesnotexist9x.png').expect(404);
  });

  it('404s for a name that is not a bare filename', async () => {
    await alice.agent.get('/uploads/..%2F..%2Fetc%2Fpasswd').expect(404);
  });
});

describe('attachment ownership', () => {
  it("does not serve one user's attachment to another signed-in user", async () => {
    const { url } = await store(alice);
    await bob.agent.get(url).expect(404);
  });

  it('does not serve attachments to an anonymous caller', async () => {
    const { url } = await store(alice);
    await request(app).get(url).expect(404);
  });
});

describe('share-link guests and embedded images', () => {
  /** Join a share link and return an agent carrying the guest cookie. */
  async function joinAsGuest(token: string) {
    const guest = request.agent(app);
    await guest.post(`/api/share/${token}/join`).send({ displayName: 'Guest' }).expect(200);
    return guest;
  }

  async function shareNote(owner: TestUser, noteId: string): Promise<string> {
    const res = await owner.agent
      .post(`/api/notes/${noteId}/shares`)
      .send({ permission: 'view' })
      .expect(201);
    return res.body.token;
  }

  it('lets a guest load an image embedded in the note they were given access to', async () => {
    const notebookId = await insertNotebook(alice.id);
    const { url, storedName } = await store(alice);
    // The image is referenced from the note body, which is how editor uploads appear.
    const noteId = await insertNote(alice.id, notebookId, {
      content_json: JSON.stringify({
        type: 'doc',
        content: [{ type: 'image', attrs: { src: url } }],
      }),
    });

    const token = await shareNote(alice, noteId);
    const guest = await joinAsGuest(token);

    const res = await guest.get(`/uploads/${storedName}`).expect(200);
    expect(Buffer.from(res.body).equals(PNG)).toBe(true);
  });

  it('lets a guest load a figure filed against the shared note by note_id', async () => {
    const notebookId = await insertNotebook(alice.id);
    const noteId = await insertNote(alice.id, notebookId);
    // Slide figures are stored with note_id set, and are not necessarily in content_json
    // by the time the row is written — note_id is the association that matters for them.
    const { storedName } = await store(alice, { noteId });

    const token = await shareNote(alice, noteId);
    const guest = await joinAsGuest(token);

    await guest.get(`/uploads/${storedName}`).expect(200);
  });

  it('does not let a guest reach the owner\'s other attachments', async () => {
    const notebookId = await insertNotebook(alice.id);
    const sharedNoteId = await insertNote(alice.id, notebookId);
    const token = await shareNote(alice, sharedNoteId);
    const guest = await joinAsGuest(token);

    // An attachment belonging to Alice but not referenced by the shared note.
    const unrelated = await store(alice);
    await guest.get(`/uploads/${unrelated.storedName}`).expect(404);
  });

  it('stops serving once the share is revoked', async () => {
    const notebookId = await insertNotebook(alice.id);
    const noteId = await insertNote(alice.id, notebookId);
    const { storedName } = await store(alice, { noteId });

    const created = await alice.agent
      .post(`/api/notes/${noteId}/shares`)
      .send({ permission: 'view' })
      .expect(201);
    const guest = await joinAsGuest(created.body.token);
    await guest.get(`/uploads/${storedName}`).expect(200);

    await alice.agent.delete(`/api/shares/${created.body.share.id}`).expect(200);
    await guest.get(`/uploads/${storedName}`).expect(404);
  });
});

describe('temp files for extraction', () => {
  it('exposes the bytes at a real path and deletes the file afterwards', async () => {
    let seen = '';
    const contents = await withTempFile(Buffer.from('hello'), '.txt', async (p) => {
      seen = p;
      return fs.readFile(p, 'utf8');
    });
    expect(contents).toBe('hello');
    await expect(fs.access(seen)).rejects.toThrow();
  });

  it('still deletes the file when the callback throws', async () => {
    let seen = '';
    await expect(
      withTempFile(Buffer.from('x'), '.txt', async (p) => {
        seen = p;
        throw new Error('extractor blew up');
      }),
    ).rejects.toThrow('extractor blew up');
    await expect(fs.access(seen)).rejects.toThrow();
  });
});

describe('slide figures', () => {
  it('labels each figure with the slide it came from', () => {
    const md = figuresMarkdown([
      { slide: 2, url: '/uploads/a.png' },
      { slide: 7, url: '/uploads/b.png' },
    ]);
    expect(md).toContain('## Figures from the slides');
    expect(md).toContain('**Slide 2**');
    expect(md).toContain('![Figure from slide 7](/uploads/b.png)');
  });

  it('produces nothing when the deck had no usable figures', () => {
    expect(figuresMarkdown([])).toBe('');
  });

  it('converts to real TipTap image nodes pointing at the stored URLs', () => {
    const doc = markdownToTipTap(figuresMarkdown([{ slide: 3, url: '/uploads/fig3.png' }])) as {
      content: Array<{ type: string; content?: Array<{ type: string; attrs?: { src?: string } }> }>;
    };
    const srcs = JSON.stringify(doc).match(/"src":"([^"]+)"/g) ?? [];
    expect(srcs.join()).toContain('/uploads/fig3.png');
  });

  it('only treats .pptx as having extractable figures — a PDF is skipped, not searched', () => {
    expect(isPptx('application/vnd.openxmlformats-officedocument.presentationml.presentation', 'deck.pptx')).toBe(true);
    expect(isPptx('', 'deck.pptx')).toBe(true);
    expect(isPptx('application/pdf', 'slides.pdf')).toBe(false);
  });
});
