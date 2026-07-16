import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';

// Env must be set before anything transitively imports db.ts (see data.test.ts).
const dbPath = path.join(os.tmpdir(), `folio-fixes-test-${process.pid}-${Date.now()}.db`);
process.env.FOLIO_DB_PATH = dbPath;

const { db, newId } = await import('../src/db.js');
const { buildApp } = await import('../src/app.js');
const { capForAi, AI_MAX_CHARS } = await import('../src/ai/client.js');
const { kindAccepts, stripLeadingTitleHeading, appendMarkdownToNote, withNoteLock } = await import('../src/routes/imports.js');

const app = buildApp();

async function mkNotebook(name = 'NB') {
  const res = await request(app).post('/api/notebooks').send({ name });
  return res.body.notebook;
}
async function mkNote(notebookId: string, overrides: Record<string, unknown> = {}) {
  const res = await request(app).post('/api/notes').send({ notebookId, title: 'Untitled', ...overrides });
  return res.body.note;
}
function insertCard(noteId: string | null, opts: Partial<{ ease: number; interval_days: number; reps: number; due_at: string; suspended: number }> = {}): string {
  const id = newId();
  db.prepare(
    `INSERT INTO flashcards (id, note_id, question, answer, ease, interval_days, reps, lapses, due_at, suspended)
     VALUES (@id, @note_id, 'Q?', 'A.', @ease, @interval_days, @reps, 0, @due_at, @suspended)`,
  ).run({
    id, note_id: noteId,
    ease: opts.ease ?? 2.5, interval_days: opts.interval_days ?? 0, reps: opts.reps ?? 0,
    due_at: opts.due_at ?? new Date(Date.now() - 5 * 60_000).toISOString(), suspended: opts.suspended ?? 0,
  });
  return id;
}

beforeEach(() => {
  db.exec('DELETE FROM review_log; DELETE FROM flashcards; DELETE FROM note_versions; DELETE FROM links; DELETE FROM note_tags; DELETE FROM attachments; DELETE FROM notes; DELETE FROM notebooks;');
});
afterAll(() => {
  db.close();
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + s); } catch { /* ignore */ } }
});

// --- Fix 8: contentJson validation --------------------------------------------------------
describe('contentJson validation (fix 8)', () => {
  it('rejects null / non-doc contentJson with 400 on create and patch', async () => {
    const nb = await mkNotebook();
    expect((await request(app).post('/api/notes').send({ notebookId: nb.id, contentJson: null })).status).toBe(400);
    expect((await request(app).post('/api/notes').send({ notebookId: nb.id, contentJson: 'nope' })).status).toBe(400);
    expect((await request(app).post('/api/notes').send({ notebookId: nb.id, contentJson: { type: 'paragraph' } })).status).toBe(400);
    expect((await request(app).post('/api/notes').send({ notebookId: nb.id, contentJson: { type: 'doc' } })).status).toBe(400); // no content array

    const note = await mkNote(nb.id);
    expect((await request(app).patch(`/api/notes/${note.id}`).send({ contentJson: null })).status).toBe(400);
    expect((await request(app).patch(`/api/notes/${note.id}`).send({ contentJson: { type: 'doc', content: [] } })).status).toBe(200);
  });

  it('accepts a valid TipTap doc', async () => {
    const nb = await mkNotebook();
    const res = await request(app).post('/api/notes').send({ notebookId: nb.id, contentJson: { type: 'doc', content: [{ type: 'paragraph' }] } });
    expect(res.status).toBe(201);
  });
});

// --- Fix 13: soft-delete + undelete -------------------------------------------------------
describe('soft-delete + undelete (fix 13)', () => {
  it('DELETE soft-deletes: note vanishes from reads but undelete restores it', async () => {
    const nb = await mkNotebook();
    const note = await mkNote(nb.id, { title: 'Trashable', contentText: 'find me softdelete', contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'find me softdelete' }] }] } });

    expect((await request(app).delete(`/api/notes/${note.id}`)).status).toBe(200);
    expect((await request(app).get(`/api/notes/${note.id}`)).status).toBe(404); // gone from GET
    expect((await request(app).get(`/api/notes?notebookId=${nb.id}`)).body.total).toBe(0); // gone from list
    expect((await request(app).get('/api/search?q=softdelete')).body.results).toHaveLength(0); // gone from search
    expect((await request(app).get('/api/notes/recent')).body.notes.map((n: { id: string }) => n.id)).not.toContain(note.id);

    const undo = await request(app).post(`/api/notes/${note.id}/undelete`);
    expect(undo.status).toBe(200);
    expect(undo.body.note.id).toBe(note.id);
    expect((await request(app).get(`/api/notes/${note.id}`)).status).toBe(200); // back
    expect((await request(app).get(`/api/notes?notebookId=${nb.id}`)).body.total).toBe(1);
  });

  it('undelete restores incoming backlinks', async () => {
    const nb = await mkNotebook();
    const target = await mkNote(nb.id, { title: 'Deadlock' });
    const source = await mkNote(nb.id, { title: 'OS', contentText: 'See [[Deadlock]] notes.' });
    // sanity: backlink exists
    expect((await request(app).get(`/api/notes/${target.id}`)).body.backlinks.map((n: { id: string }) => n.id)).toContain(source.id);

    await request(app).delete(`/api/notes/${target.id}`);
    await request(app).post(`/api/notes/${target.id}/undelete`);
    const detail = await request(app).get(`/api/notes/${target.id}`);
    expect(detail.body.backlinks.map((n: { id: string }) => n.id)).toContain(source.id);
  });

  it('purges notes deleted more than 30 days ago on the sweep', async () => {
    const nb = await mkNotebook();
    const note = await mkNote(nb.id);
    await request(app).delete(`/api/notes/${note.id}`);
    db.prepare('UPDATE notes SET deleted_at = ? WHERE id = ?').run(new Date(Date.now() - 31 * 86_400_000).toISOString(), note.id);
    const { purgeExpiredDeletedNotes } = await import('../src/db.js');
    expect(purgeExpiredDeletedNotes(30)).toBe(1);
    expect(db.prepare('SELECT COUNT(*) as c FROM notes WHERE id = ?').get(note.id)).toMatchObject({ c: 0 });
  });
});

// --- Fix 7: rename is link-preserving -----------------------------------------------------
describe('rename note keeps backlinks (fix 7)', () => {
  it('renaming a linked note updates referencing notes and preserves the link', async () => {
    const nb = await mkNotebook();
    const target = await mkNote(nb.id, { title: 'Old Title' });
    const source = await mkNote(nb.id, {
      title: 'Source',
      contentText: 'See [[Old Title]] here.',
      contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [
        { type: 'text', text: 'See ' },
        { type: 'wikilink', attrs: { noteId: target.id, title: 'Old Title', alias: null } },
        { type: 'text', text: ' here.' },
      ] }] },
    });
    expect((await request(app).get(`/api/notes/${target.id}`)).body.backlinks.map((n: { id: string }) => n.id)).toContain(source.id);

    await request(app).patch(`/api/notes/${target.id}`).send({ title: 'New Title' });

    // Backlink survives the rename.
    const targetDetail = await request(app).get(`/api/notes/${target.id}`);
    expect(targetDetail.body.backlinks.map((n: { id: string }) => n.id)).toContain(source.id);
    // The referencing note's text + wikilink node now show the new title.
    const src = await request(app).get(`/api/notes/${source.id}`);
    expect(src.body.note.contentText).toContain('[[New Title]]');
    const wl = JSON.stringify(src.body.note.contentJson);
    expect(wl).toContain('New Title');
    expect(wl).not.toContain('Old Title');
  });
});

// --- Fix 6: single wikilink extractor handles [[Title|Alias]] on the import path ----------
describe('import wikilink extraction handles aliases (fix 6)', () => {
  it('appendMarkdownToNote resolves an aliased [[Title|Alias]] link via lib/links', async () => {
    const nb = await mkNotebook();
    const target = await mkNote(nb.id, { title: 'Binary Search' });
    const host = await mkNote(nb.id, { title: 'Host', contentText: 'start' });

    appendMarkdownToNote(host.id, 'See [[Binary Search|the search]] for detail.');

    const detail = await request(app).get(`/api/notes/${host.id}`);
    expect(detail.body.outgoingLinks.map((n: { id: string }) => n.id)).toContain(target.id);
  });
});

// --- Fix 5: concurrent appends never lose a write -----------------------------------------
describe('concurrent import appends are serialized (fix 5)', () => {
  it('N concurrent appends via withNoteLock all persist', async () => {
    const nb = await mkNotebook();
    const note = await mkNote(nb.id, { title: 'Log', contentText: 'base' });
    const markers = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO'];
    await Promise.all(markers.map(m => withNoteLock(note.id, () => appendMarkdownToNote(note.id, `Marker ${m} line.`))));
    const detail = await request(app).get(`/api/notes/${note.id}`);
    for (const m of markers) expect(detail.body.note.contentText).toContain(m);
  });
});

// --- Fix 11: AI size guard ----------------------------------------------------------------
describe('capForAi (fix 11)', () => {
  it('leaves short text untouched and truncates long text with a marker', () => {
    expect(capForAi('short')).toBe('short');
    const long = 'x'.repeat(AI_MAX_CHARS + 5000);
    const capped = capForAi(long);
    expect(capped.length).toBeLessThan(long.length);
    expect(capped.endsWith('[truncated]')).toBe(true);
    expect(capForAi('a'.repeat(100), 50).length).toBeLessThan(100);
  });
});

// --- Fix 12: SM-2 relearn escape + ease ceiling -------------------------------------------
describe('SM-2 scheduler (fix 12)', () => {
  it('a fresh card rated hard twice in a row graduates out of the relearn loop', async () => {
    const nb = await mkNotebook();
    const note = await mkNote(nb.id);
    const cardId = insertCard(note.id, { ease: 2.5, interval_days: 0, reps: 0 });

    // First hard → 10-minute relearning step, still new.
    await request(app).post('/api/study/review').send({ cardId, rating: 'hard' });
    let row = db.prepare('SELECT * FROM flashcards WHERE id = ?').get(cardId) as any;
    expect(row.reps).toBe(0);
    expect(row.interval_days).toBe(0);

    // Second consecutive hard → graduate to a 1-day interval.
    await request(app).post('/api/study/review').send({ cardId, rating: 'hard' });
    row = db.prepare('SELECT * FROM flashcards WHERE id = ?').get(cardId) as any;
    expect(row.reps).toBe(1);
    expect(row.interval_days).toBe(1);
    const dueAt = new Date(row.due_at).getTime();
    expect(Math.abs(dueAt - (Date.now() + 86_400_000))).toBeLessThan(5_000);
  });

  it('caps ease at 3.0 no matter how many easy ratings', async () => {
    const nb = await mkNotebook();
    const note = await mkNote(nb.id);
    const cardId = insertCard(note.id, { ease: 2.95, interval_days: 5, reps: 3 });
    await request(app).post('/api/study/review').send({ cardId, rating: 'easy' });
    const row = db.prepare('SELECT * FROM flashcards WHERE id = ?').get(cardId) as any;
    expect(row.ease).toBe(3.0);
  });
});

// --- Fix 9: reviewedToday uses the local day ----------------------------------------------
describe('reviewedToday local-day boundary (fix 9)', () => {
  it('counts a review done now and ignores one from days ago', async () => {
    const nb = await mkNotebook();
    const note = await mkNote(nb.id);
    const cardId = insertCard(note.id);
    await request(app).post('/api/study/review').send({ cardId, rating: 'good' });
    // A stray old review must not inflate today's count.
    db.prepare('INSERT INTO review_log (card_id, rating, reviewed_at) VALUES (?, ?, ?)').run(cardId, 'good', new Date(Date.now() - 3 * 86_400_000).toISOString());

    const stats = await request(app).get('/api/study/stats');
    expect(stats.body.reviewedToday).toBe(1);
  });
});

// --- Fix 24: study queue notebook filter --------------------------------------------------
describe('study queue notebookId filter (fix 24)', () => {
  it('scopes cards and counts to one notebook', async () => {
    const nbA = await mkNotebook('A');
    const nbB = await mkNotebook('B');
    const noteA = await mkNote(nbA.id, { title: 'A note' });
    const noteB = await mkNote(nbB.id, { title: 'B note' });
    insertCard(noteA.id);
    insertCard(noteA.id);
    insertCard(noteB.id);

    const all = await request(app).get('/api/study/queue');
    expect(all.body.total).toBe(3);
    expect(all.body.due).toBe(3);

    const scoped = await request(app).get(`/api/study/queue?notebookId=${nbA.id}`);
    expect(scoped.body.total).toBe(2);
    expect(scoped.body.due).toBe(2);
    expect(scoped.body.cards).toHaveLength(2);
    for (const c of scoped.body.cards) expect(c.notebookId).toBe(nbA.id);
  });
});

// --- Fix 19: kindAccepts pptx/docx --------------------------------------------------------
describe('kindAccepts pptx/docx (fix 19)', () => {
  it('accepts pptx for slides and docx for transcript, rejects mismatches', () => {
    const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    expect(kindAccepts('slides', PPTX, 'deck.pptx')).toBe(true);
    expect(kindAccepts('slides', 'application/octet-stream', 'deck.pptx')).toBe(true); // by ext
    expect(kindAccepts('slides', DOCX, 'essay.docx')).toBe(false); // docx is not a slide deck
    expect(kindAccepts('transcript', DOCX, 'essay.docx')).toBe(true);
    expect(kindAccepts('transcript', 'text/plain', 'notes.txt')).toBe(true);
    expect(kindAccepts('photo', PPTX, 'deck.pptx')).toBe(false);
  });
});

// --- Fix 23: strip duplicate leading title heading ----------------------------------------
describe('stripLeadingTitleHeading (fix 23)', () => {
  it('drops a leading H1 that repeats the title, keeps everything else', () => {
    const md = '# Big-O Notation\n\nBig-O describes growth.';
    expect(stripLeadingTitleHeading(md, 'Big-O Notation')).toBe('Big-O describes growth.');
    // Case/whitespace/trailing punctuation tolerant.
    expect(stripLeadingTitleHeading('#   big-o notation.  \n\nBody', 'Big-O Notation')).toBe('Body');
    // A non-matching leading heading is preserved.
    const md2 = '# Introduction\n\nText.';
    expect(stripLeadingTitleHeading(md2, 'Big-O Notation')).toBe(md2);
    // No leading heading → unchanged.
    expect(stripLeadingTitleHeading('Just text', 'Anything')).toBe('Just text');
  });
});

// --- Attachments surfaced on GET note (fix 21) --------------------------------------------
describe('attachments on GET note (fix 21)', () => {
  it('returns an attachments array with a public url', async () => {
    const nb = await mkNotebook();
    const note = await mkNote(nb.id);
    const attId = newId();
    db.prepare(
      `INSERT INTO attachments (id, note_id, kind, original_name, stored_name, mime, size, status, created_at)
       VALUES (?, ?, 'photo', 'page.png', 'stored123.png', 'image/png', 1234, 'ready', ?)`,
    ).run(attId, note.id, new Date().toISOString());

    const detail = await request(app).get(`/api/notes/${note.id}`);
    expect(detail.body.note.attachments).toHaveLength(1);
    expect(detail.body.note.attachments[0]).toMatchObject({ id: attId, kind: 'photo', url: '/uploads/stored123.png', mime: 'image/png' });
  });
});
