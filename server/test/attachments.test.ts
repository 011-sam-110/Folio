// Attachment storage and serving.
//
// The bug these cover: uploads were written to data/uploads/ with multer.diskStorage, which
// is a read-only path on the deployed serverless host - every import in production failed
// with EROFS before any of the logic below ran. Payloads now live in attachments.bytes and
// are served from there, so these tests assert the two halves of that: the write puts real
// bytes in the row, and the read hands them back to the right people and nobody else.

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import { buildApp } from '../src/app.js';
import { db } from '../src/db.js';
import { insertAttachment, withTempFile, attachmentUrl } from '../src/lib/attachments.js';
import { extractFromUpload } from '../src/lib/extract.js';
import { pagesProvenance, timelineProvenance, parseProvenance } from '../src/lib/provenance.js';
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

afterEach(() => {
  // Only the provenance suite below stubs anything, but unstubbing centrally means a failed
  // assertion there cannot leave a fake `fetch` in place for the next file.
  vi.unstubAllGlobals();
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

  async function shareNote(
    owner: TestUser,
    noteId: string,
    permission: 'view' | 'edit' = 'view',
  ): Promise<string> {
    const res = await owner.agent
      .post(`/api/notes/${noteId}/shares`)
      .send({ permission })
      .expect(201);
    return res.body.token;
  }

  // Access is decided ONLY by attachments.note_id - a column no requester can write. These
  // cover both halves of that: the owner's own writes file editor uploads against the note
  // so legitimate images still render, and nothing a guest can type grants anything.

  it('files an editor upload against the note when the owner saves, so a guest can load it', async () => {
    const notebookId = await insertNotebook(alice.id);

    // Exactly the real flow: upload with no note_id, then save the note that embeds it.
    const up = await alice.agent
      .post('/api/import/image')
      .attach('file', PNG, { filename: 'shot.png', contentType: 'image/png' })
      .expect(200);
    const url: string = up.body.url;
    const storedName = url.slice('/uploads/'.length);

    const created = await alice.agent
      .post('/api/notes')
      .send({ notebookId, title: 'With a picture' })
      .expect(201);
    const noteId: string = created.body.note.id;

    await alice.agent
      .patch(`/api/notes/${noteId}`)
      .send({ contentJson: { type: 'doc', content: [{ type: 'image', attrs: { src: url } }] } })
      .expect(200);

    // The association is now a real column value, not an inference from body text.
    const row = await db
      .prepare('SELECT note_id FROM attachments WHERE stored_name = ?')
      .get<{ note_id: string | null }>(storedName);
    expect(row?.note_id).toBe(noteId);

    const guest = await joinAsGuest(await shareNote(alice, noteId));
    const res = await guest.get(url).expect(200);
    expect(Buffer.from(res.body).equals(PNG)).toBe(true);
  });

  it('files images embedded before this rule existed when the note is shared', async () => {
    // A note written when uploads carried no note_id at all. Sharing it is the last
    // owner-authenticated moment before a guest exists, so the backfill happens there.
    const notebookId = await insertNotebook(alice.id);
    const { url, storedName } = await store(alice, { noteId: null });
    const noteId = await insertNote(alice.id, notebookId, {
      content_json: JSON.stringify({
        type: 'doc',
        content: [{ type: 'image', attrs: { src: url } }],
      }),
    });

    const guest = await joinAsGuest(await shareNote(alice, noteId));
    const res = await guest.get(`/uploads/${storedName}`).expect(200);
    expect(Buffer.from(res.body).equals(PNG)).toBe(true);

    const row = await db
      .prepare('SELECT note_id FROM attachments WHERE stored_name = ?')
      .get<{ note_id: string | null }>(storedName);
    expect(row?.note_id).toBe(noteId);
  });

  it('does not let an edit-permission guest mint access by writing a URL into the note', async () => {
    // The reported flaw. Mallory owns a note, shares it to herself with edit rights, and
    // pastes a victim's attachment URL into the body. Access used to be granted from that
    // body text, which she fully controls; it must now come only from attachments.note_id.
    const victimAttachment = await store(bob);

    const mallorysNotebook = await insertNotebook(alice.id);
    const mallorysNote = await insertNote(alice.id, mallorysNotebook);
    const token = await shareNote(alice, mallorysNote, 'edit');
    const guest = await joinAsGuest(token);

    await guest
      .patch(`/api/share/${token}/note`)
      .send({
        contentJson: {
          type: 'doc',
          content: [{ type: 'image', attrs: { src: victimAttachment.url } }],
        },
      })
      .expect(200);

    // The write landed - this is not passing because the edit was rejected.
    const note = await db
      .prepare('SELECT content_json FROM notes WHERE id = ?')
      .get<{ content_json: string }>(mallorysNote);
    expect(note?.content_json).toContain(victimAttachment.storedName);

    // But it bought her nothing, and Bob's row was not re-pointed at her note either.
    await guest.get(victimAttachment.url).expect(404);
    const row = await db
      .prepare('SELECT note_id FROM attachments WHERE stored_name = ?')
      .get<{ note_id: string | null }>(victimAttachment.storedName);
    expect(row?.note_id).toBeNull();
  });

  it('does not let an owner claim another user\'s attachment by referencing its URL', async () => {
    // The same attack from the authenticated side: the backfill is scoped to rows the
    // session user already owns, so quoting someone else's URL cannot capture it.
    const victimAttachment = await store(bob);
    const notebookId = await insertNotebook(alice.id);
    const created = await alice.agent
      .post('/api/notes')
      .send({
        notebookId,
        contentJson: {
          type: 'doc',
          content: [{ type: 'image', attrs: { src: victimAttachment.url } }],
        },
      })
      .expect(201);

    const row = await db
      .prepare('SELECT note_id FROM attachments WHERE stored_name = ?')
      .get<{ note_id: string | null }>(victimAttachment.storedName);
    expect(row?.note_id).toBeNull();

    const guest = await joinAsGuest(await shareNote(alice, created.body.note.id));
    await guest.get(victimAttachment.url).expect(404);
  });

  it('lets a guest load a figure filed against the shared note by note_id', async () => {
    const notebookId = await insertNotebook(alice.id);
    const noteId = await insertNote(alice.id, notebookId);
    // Slide figures are stored with note_id set, and are not necessarily in content_json
    // by the time the row is written - note_id is the association that matters for them.
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

  it('only treats .pptx as having extractable figures - a PDF is skipped, not searched', () => {
    expect(isPptx('application/vnd.openxmlformats-officedocument.presentationml.presentation', 'deck.pptx')).toBe(true);
    expect(isPptx('', 'deck.pptx')).toBe(true);
    expect(isPptx('application/pdf', 'slides.pdf')).toBe(false);
  });
});

// Provenance: where an upload's material sits INSIDE the file it came from.
//
// The citation on a gap suggestion ("slide 14 of 31") is only worth showing if it is true, and
// it cannot be recovered later: attachments.extracted_text is the model-restructured version
// of the upload, and that pass is told to drop slide numbers and footers. The position has to
// be taken from the raw extraction, at import time, or not at all - which is what these cover.
describe('source provenance', () => {
  const tmp: string[] = [];
  afterAll(async () => {
    for (const f of tmp) await fs.rm(f, { force: true }).catch(() => {});
  });

  async function tmpFile(name: string, bytes: Buffer): Promise<string> {
    const p = path.join(os.tmpdir(), `folio-prov-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
    await fs.writeFile(p, bytes);
    tmp.push(p);
    return p;
  }

  const enc = (s: string) => new TextEncoder().encode(s);

  /** A real (if minimal) .pptx: enough package parts for officeparser to find the slides. */
  function buildPptx(slides: string[][]): Buffer {
    const slideXml = (lines: string[]) =>
      enc(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>` +
          lines
            .map(
              (t, i) =>
                `<p:sp><p:nvSpPr><p:cNvPr id="${i + 2}" name="tb${i}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp>`,
            )
            .join('') +
          `</p:spTree></p:cSld></p:sld>`,
      );
    const files: Record<string, Uint8Array> = {
      '[Content_Types].xml': enc(
        `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>${slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')}</Types>`,
      ),
      '_rels/.rels': enc(
        `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
      ),
      'ppt/presentation.xml': enc(
        `<?xml version="1.0"?><p:presentation xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('')}</p:sldIdLst></p:presentation>`,
      ),
      'ppt/_rels/presentation.xml.rels': enc(
        `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('')}</Relationships>`,
      ),
    };
    slides.forEach((lines, i) => {
      files[`ppt/slides/slide${i + 1}.xml`] = slideXml(lines);
    });
    return Buffer.from(zipSync(files));
  }

  /** A real PDF with one text-bearing page per entry, so unpdf paginates it for real. */
  function buildPdf(pages: string[]): Buffer {
    const contentIds = pages.map((_, i) => 4 + pages.length + i);
    const fontId = 3 + pages.length;
    const objs = [
      `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`,
      `2 0 obj\n<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i} 0 R`).join(' ')}] /Count ${pages.length} >>\nendobj\n`,
      ...pages.map(
        (_, i) =>
          `${3 + i} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentIds[i]} 0 R >>\nendobj\n`,
      ),
      `${fontId} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`,
      ...pages.map((text, i) => {
        const stream = `BT /F1 18 Tf 72 700 Td (${text}) Tj ET`;
        return `${contentIds[i]} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`;
      }),
    ];
    let pdf = '%PDF-1.4\n';
    const offsets: number[] = [];
    for (const o of objs) {
      offsets.push(pdf.length);
      pdf += o;
    }
    const xrefAt = pdf.length;
    pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
    pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
    return Buffer.from(pdf, 'latin1');
  }

  describe('what the extractor reports', () => {
    it('cuts a .pptx where the deck cuts it, one entry per slide', async () => {
      const file = await tmpFile(
        'deck.pptx',
        buildPptx([['Lecture 8: Normalisation'], ['Third Normal Form', 'No transitive dependency'], ['Denormalisation']]),
      );

      const res = await extractFromUpload(file, '', 'deck.pptx');

      expect(res.pages).toEqual([
        'Lecture 8: Normalisation',
        'Third Normal Form\nNo transitive dependency',
        'Denormalisation',
      ]);
      // The flattened text is unchanged by the split, so nothing that already read it moves.
      expect(res.text).toBe(res.pages!.join('\n'));
    });

    it('cuts a PDF page by page, keeping the page count honest', async () => {
      const file = await tmpFile('deck.pdf', buildPdf(['Deadlock conditions', 'Circular wait', 'Prevention']));

      const res = await extractFromUpload(file, 'application/pdf', 'deck.pdf');

      expect(res.pages).toEqual(['Deadlock conditions', 'Circular wait', 'Prevention']);
      expect(res.meta.pages).toBe(3);
    });

    it('reports no pages for a format that has none', async () => {
      const file = await tmpFile('notes.txt', Buffer.from('Just some text with no page structure.'));
      const res = await extractFromUpload(file, 'text/plain', 'notes.txt');
      expect(res.pages).toBeUndefined();
    });
  });

  describe('numbering', () => {
    it('numbers from 1 and keeps a blank page in place', () => {
      // Compacting the array would move slide 3 to position 2, which is the exact failure the
      // whole feature exists to prevent.
      const prov = pagesProvenance('slide', ['Intro', '', 'Third Normal Form']);
      expect(prov).toEqual({
        kind: 'pages',
        unit: 'slide',
        total: 3,
        pages: [
          { n: 1, text: 'Intro' },
          { n: 2, text: '' },
          { n: 3, text: 'Third Normal Form' },
        ],
      });
    });

    it('records that a file with no pages has none, rather than saying nothing', () => {
      expect(pagesProvenance('slide', [])).toEqual({ kind: 'none', reason: 'no-pages' });
    });
  });

  describe('reading a timeline out of a transcript', () => {
    it('reads WebVTT cues, keeping the end the file states', () => {
      const prov = timelineProvenance(
        ['WEBVTT', '', '00:24:10.000 --> 00:28:35.000', 'Circular wait.', '', '00:28:35.000 --> 00:31:02.000', 'Prevention.'].join('\n'),
      );
      expect(prov).toEqual({
        kind: 'timestamps',
        segments: [
          { start: 1450, end: 1715, text: 'Circular wait.' },
          { start: 1715, end: 1862, text: 'Prevention.' },
        ],
      });
    });

    it('reads bare timestamps, taking each segment up to where the next one starts', () => {
      const prov = timelineProvenance(['0:00 Welcome to the lecture.', '24:10', 'The fourth condition is circular wait.'].join('\n'));
      expect(prov).toEqual({
        kind: 'timestamps',
        segments: [
          { start: 0, end: 1450, text: 'Welcome to the lecture.' },
          // Nothing in the file says when the last segment ends, so nothing here claims to.
          { start: 1450, end: null, text: 'The fourth condition is circular wait.' },
        ],
      });
    });

    it('does not read a timeline out of prose that merely mentions a time', () => {
      expect(timelineProvenance('The lecture starts at 09:15 and covers deadlock detection.')).toBeNull();
    });

    it('does not read a timeline out of clock times that run backwards', () => {
      // A timetable, not a recording. Its times are real but they are not positions in a file,
      // and a citation pointing into them would send the student nowhere.
      expect(timelineProvenance(['12:30 Lunch', '09:15 Registration', '14:00 Lab'].join('\n'))).toBeNull();
    });
  });

  describe('what an import stores', () => {
    /** The gateway, answering every call with the same markdown. Nothing reaches upstream. */
    function stubModel(markdown = '## Circular wait\n\nA cycle in the wait-for graph.') {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(JSON.stringify({ choices: [{ message: { content: markdown } }] }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
        ),
      );
    }

    /** Run a real import to completion and return what it wrote to attachments.provenance. */
    async function importAndRead(
      kind: string,
      file: { name: string; type: string; bytes: Buffer },
    ): Promise<unknown> {
      stubModel();
      const notebookId = await insertNotebook(alice.id);
      const res = await alice.agent
        .post('/api/import')
        .field('kind', kind)
        .field('mode', 'new')
        .field('notebookId', notebookId)
        .attach('file', file.bytes, { filename: file.name, contentType: file.type })
        .expect(200);

      // The job runs after the response, so the assertion has to wait for it rather than for
      // the request.
      for (let i = 0; i < 200; i++) {
        const job = await alice.agent.get(`/api/import/jobs/${res.body.jobId}`);
        if (job.body.status === 'done') break;
        if (job.body.status === 'failed') throw new Error(`import failed: ${job.body.error}`);
        await new Promise(r => setTimeout(r, 25));
      }

      const row = await db
        .prepare('SELECT provenance FROM attachments WHERE user_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1')
        .get<{ provenance: string | null }>(alice.id, kind);
      return parseProvenance(row?.provenance);
    }

    it('records a deck page by page, with the total a citation needs', async () => {
      const prov = await importAndRead('slides', {
        name: 'deck.pdf',
        type: 'application/pdf',
        bytes: buildPdf(['Deadlock conditions', 'Circular wait', 'Prevention']),
      });

      expect(prov).toEqual({
        kind: 'pages',
        unit: 'slide',
        total: 3,
        pages: [
          { n: 1, text: 'Deadlock conditions' },
          { n: 2, text: 'Circular wait' },
          { n: 3, text: 'Prevention' },
        ],
      });
    });

    it('records a transcript timeline from the raw text, before the AI pass rewrites it', async () => {
      const prov = await importAndRead('transcript', {
        name: 'lecture3.txt',
        type: 'text/plain',
        bytes: Buffer.from(['0:00 Welcome.', '24:10 The fourth condition is circular wait.'].join('\n')),
      });

      expect(prov).toEqual({
        kind: 'timestamps',
        segments: [
          { start: 0, end: 1450, text: 'Welcome.' },
          { start: 1450, end: null, text: 'The fourth condition is circular wait.' },
        ],
      });
    });

    it('records the ABSENCE of a timeline, so nothing downstream has to guess', async () => {
      const prov = await importAndRead('transcript', {
        name: 'notes.txt',
        type: 'text/plain',
        bytes: Buffer.from('A deadlock needs mutual exclusion, hold and wait, no preemption and circular wait.'),
      });

      expect(prov).toEqual({ kind: 'none', reason: 'no-timestamps' });
    });

    it('records a photo as having no sub-position at all', async () => {
      const prov = await importAndRead('photo', { name: 'page-3.png', type: 'image/png', bytes: PNG });
      expect(prov).toEqual({ kind: 'none', reason: 'photo' });
    });
  });
});
