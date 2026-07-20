import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

// Same pattern as server/test/study.test.ts: the DB connection opens at import time
// (db.ts reads FOLIO_DB_PATH via config.ts), so the env var must be set before anything
// that transitively imports it. Static imports are hoisted, so pull in the router with a
// dynamic import after setting the env var.
const dbPath = path.join(os.tmpdir(), `folio-templates-test-${process.pid}-${Date.now()}.db`);
process.env.FOLIO_DB_PATH = dbPath;

const { db } = await import('../src/db.js');
// app.ts isn't mounting /api/templates yet (that wiring is the integration captain's
// job) — build a minimal standalone app around just this router so the test doesn't
// depend on that integration step having happened yet.
const templatesRouter = (await import('../src/routes/templates.js')).default;

const app = express();
app.use(express.json());
app.use('/api/templates', templatesRouter);

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

interface TemplateDto {
  id: string;
  name: string;
  emoji: string;
  description: string;
  contentJson: { type: string; content: unknown[] };
  builtin: boolean;
  createdAt: string;
}

function findNodes(node: unknown, type: string, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (!node || typeof node !== 'object') return out;
  const n = node as { type?: string; content?: unknown[] };
  if (n.type === type) out.push(n as Record<string, unknown>);
  if (Array.isArray(n.content)) for (const c of n.content) findNodes(c, type, out);
  return out;
}

// Run first, against the pristine (import-time-seeded) DB, so seeding assertions aren't
// polluted by templates other tests create later in the file.
describe('boot seeding (runs first, before other tests add templates)', () => {
  it('seeds exactly the two builtin templates when the table starts empty', async () => {
    const res = await request(app).get('/api/templates');
    expect(res.status).toBe(200);
    const templates = res.body.templates as TemplateDto[];
    expect(templates).toHaveLength(2);
    expect(templates.every((tpl) => tpl.builtin)).toBe(true);
    expect(new Set(templates.map((tpl) => tpl.name))).toEqual(new Set(['Lecture note', 'Cornell notes']));
    for (const tpl of templates) {
      expect(tpl.emoji).toBeTruthy();
      expect(tpl.description.length).toBeGreaterThan(0);
      expect(tpl.contentJson.type).toBe('doc');
      expect(Array.isArray(tpl.contentJson.content)).toBe(true);
      expect(tpl.contentJson.content.length).toBeGreaterThan(0);
    }
  });

  it('builds "Lecture note" with a key-terms toggle, a worked example and review questions', async () => {
    const res = await request(app).get('/api/templates');
    const lecture = (res.body.templates as TemplateDto[]).find((tpl) => tpl.name === 'Lecture note')!;
    expect(lecture).toBeTruthy();

    const toggles = findNodes(lecture.contentJson, 'details');
    expect(toggles).toHaveLength(1);
    const summaryText = findNodes(toggles[0], 'detailsSummary')[0]?.content as Array<{ text?: string }> | undefined;
    expect(summaryText?.[0]?.text).toBe('Key terms');
    expect(findNodes(toggles[0], 'detailsContent')).toHaveLength(1);

    const headings = findNodes(lecture.contentJson, 'heading').map(
      (h) => (h.content as Array<{ text?: string }>)?.[0]?.text,
    );
    expect(headings).toContain('Worked example');
    expect(headings).toContain('Questions to review');

    expect(findNodes(lecture.contentJson, 'taskList')).toHaveLength(1);
    expect(findNodes(lecture.contentJson, 'taskItem').length).toBeGreaterThan(0);
  });

  it('builds "Cornell notes" with the columnList/column contract and a summary callout', async () => {
    const res = await request(app).get('/api/templates');
    const cornell = (res.body.templates as TemplateDto[]).find((tpl) => tpl.name === 'Cornell notes')!;
    expect(cornell).toBeTruthy();

    const columnLists = findNodes(cornell.contentJson, 'columnList');
    expect(columnLists).toHaveLength(1);
    const columns = findNodes(columnLists[0], 'column');
    expect(columns.length).toBeGreaterThanOrEqual(2);
    expect(columns.length).toBeLessThanOrEqual(4);
    for (const col of columns) {
      const attrs = col.attrs as { width: unknown };
      expect(attrs).toEqual({ width: null });
    }

    const callouts = findNodes(cornell.contentJson, 'callout');
    expect(callouts).toHaveLength(1);
    expect((callouts[0].attrs as { emoji: string; tone: string }).tone).toBeTruthy();
  });
});

describe('POST /api/templates', () => {
  const validDoc = { type: 'doc', content: [{ type: 'paragraph' }] };

  it('creates a custom template and it shows up in the list', async () => {
    const res = await request(app)
      .post('/api/templates')
      .send({ name: 'Meeting minutes', emoji: '🗒️', description: 'Attendees, decisions, actions.', contentJson: validDoc });
    expect(res.status).toBe(201);
    expect(res.body.template.builtin).toBe(false);
    expect(res.body.template.name).toBe('Meeting minutes');
    expect(res.body.template.id).toBeTruthy();

    const list = await request(app).get('/api/templates');
    expect((list.body.templates as TemplateDto[]).some((tpl) => tpl.id === res.body.template.id)).toBe(true);
  });

  it('defaults emoji to 📄 and description to "" when omitted', async () => {
    const res = await request(app).post('/api/templates').send({ name: 'Bare template', contentJson: validDoc });
    expect(res.status).toBe(201);
    expect(res.body.template.emoji).toBe('📄');
    expect(res.body.template.description).toBe('');
  });

  it('rejects an empty/whitespace name', async () => {
    const empty = await request(app).post('/api/templates').send({ name: '', contentJson: validDoc });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBeTruthy();

    const whitespace = await request(app).post('/api/templates').send({ name: '   ', contentJson: validDoc });
    expect(whitespace.status).toBe(400);
  });

  it('rejects a missing contentJson', async () => {
    const res = await request(app).post('/api/templates').send({ name: 'No content' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/contentJson/);
  });

  it.each([
    ['a string', 'not a doc'],
    ['null', null],
    ['a doc missing content', { type: 'doc' }],
    ['a doc with non-array content', { type: 'doc', content: 'nope' }],
    ['wrong type', { type: 'paragraph', content: [] }],
  ])('rejects invalid contentJson: %s', async (_label, contentJson) => {
    const res = await request(app).post('/api/templates').send({ name: 'Bad', contentJson });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/templates/:id', () => {
  it('404s for an unknown id', async () => {
    const res = await request(app).delete('/api/templates/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('deletes a custom template', async () => {
    const created = await request(app)
      .post('/api/templates')
      .send({ name: 'Throwaway', contentJson: { type: 'doc', content: [{ type: 'paragraph' }] } });
    const id = created.body.template.id as string;

    const del = await request(app).delete(`/api/templates/${id}`);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true });

    const list = await request(app).get('/api/templates');
    expect((list.body.templates as TemplateDto[]).some((tpl) => tpl.id === id)).toBe(false);
  });

  // Runs last: builtins CAN be deleted per docs/API.md, but doing so here permanently
  // shrinks the seeded set for the remainder of the file, so this stays at the end.
  it('allows deleting a builtin template (the user\'s choice)', async () => {
    const before = await request(app).get('/api/templates');
    const builtin = (before.body.templates as TemplateDto[]).find((tpl) => tpl.builtin)!;
    expect(builtin).toBeTruthy();

    const del = await request(app).delete(`/api/templates/${builtin.id}`);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true });

    const after = await request(app).get('/api/templates');
    expect((after.body.templates as TemplateDto[]).some((tpl) => tpl.id === builtin.id)).toBe(false);
  });
});
