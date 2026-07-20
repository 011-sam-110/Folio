import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { resetDatabase, makeUser, closeDatabase, type TestUser } from './helpers.js';

// Built via the real app rather than a standalone router mount: /api/templates is wired
// in app.ts now, and mounting the router bare would skip the requireAuth layer that
// `userId(req)` depends on.
const app = buildApp();

// This file deliberately shares one account and one database across its tests: the
// built-in templates are seeded once, install-wide, on the router's first request, and
// `seedBuiltinTemplates()` memoises that promise. A per-test TRUNCATE would delete the
// built-ins without any way to bring them back, so the schema is reset once here and the
// ordering-sensitive assertions below are kept in their original order.
let user: TestUser;
let api: TestUser['agent'];

beforeAll(async () => {
  await resetDatabase();
  user = await makeUser(app);
  api = user.agent;
});

afterAll(async () => {
  await closeDatabase();
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
    const res = await api.get('/api/templates');
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
    const res = await api.get('/api/templates');
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
    const res = await api.get('/api/templates');
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
    const res = await api
      .post('/api/templates')
      .send({ name: 'Meeting minutes', emoji: '🗒️', description: 'Attendees, decisions, actions.', contentJson: validDoc });
    expect(res.status).toBe(201);
    expect(res.body.template.builtin).toBe(false);
    expect(res.body.template.name).toBe('Meeting minutes');
    expect(res.body.template.id).toBeTruthy();

    const list = await api.get('/api/templates');
    expect((list.body.templates as TemplateDto[]).some((tpl) => tpl.id === res.body.template.id)).toBe(true);
  });

  it('defaults emoji to 📄 and description to "" when omitted', async () => {
    const res = await api.post('/api/templates').send({ name: 'Bare template', contentJson: validDoc });
    expect(res.status).toBe(201);
    expect(res.body.template.emoji).toBe('📄');
    expect(res.body.template.description).toBe('');
  });

  it('rejects an empty/whitespace name', async () => {
    const empty = await api.post('/api/templates').send({ name: '', contentJson: validDoc });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBeTruthy();

    const whitespace = await api.post('/api/templates').send({ name: '   ', contentJson: validDoc });
    expect(whitespace.status).toBe(400);
  });

  it('rejects a missing contentJson', async () => {
    const res = await api.post('/api/templates').send({ name: 'No content' });
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
    const res = await api.post('/api/templates').send({ name: 'Bad', contentJson });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/templates/:id', () => {
  it('404s for an unknown id', async () => {
    const res = await api.delete('/api/templates/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('deletes a custom template', async () => {
    const created = await api
      .post('/api/templates')
      .send({ name: 'Throwaway', contentJson: { type: 'doc', content: [{ type: 'paragraph' }] } });
    const id = created.body.template.id as string;

    const del = await api.delete(`/api/templates/${id}`);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true });

    const list = await api.get('/api/templates');
    expect((list.body.templates as TemplateDto[]).some((tpl) => tpl.id === id)).toBe(false);
  });

  // Behaviour change from the single-user build, not a weakened assertion: docs/API.md
  // said a user could delete a built-in, which was harmless when there was exactly one
  // account. Built-ins are now ONE shared row set (user_id NULL, see schema.sql), so
  // honouring that delete would remove the template for every other account on the
  // install. The route scopes its DELETE with `AND user_id = ?`, which can never match a
  // NULL-owner row, so the attempt falls through to the same 404 as an unknown id.
  it('refuses to delete a shared builtin template, since it belongs to every account', async () => {
    const before = await api.get('/api/templates');
    const builtin = (before.body.templates as TemplateDto[]).find((tpl) => tpl.builtin)!;
    expect(builtin).toBeTruthy();

    const del = await api.delete(`/api/templates/${builtin.id}`);
    expect(del.status).toBe(404);

    const after = await api.get('/api/templates');
    expect((after.body.templates as TemplateDto[]).some((tpl) => tpl.id === builtin.id)).toBe(true);
  });
});

describe('template ownership', () => {
  it("shows a user their own templates plus the shared builtins, never another account's", async () => {
    const other = await makeUser(app);
    const mine = await api
      .post('/api/templates')
      .send({ name: 'Mine only', contentJson: { type: 'doc', content: [{ type: 'paragraph' }] } });
    expect(mine.status).toBe(201);

    const theirList = await other.agent.get('/api/templates');
    expect(theirList.status).toBe(200);
    const names = (theirList.body.templates as TemplateDto[]).map((tpl) => tpl.name);
    expect(names).not.toContain('Mine only');
    // ...but the shared built-ins are still visible to them.
    expect(names).toContain('Lecture note');
  });

  it("404s rather than deleting another account's template", async () => {
    const other = await makeUser(app);
    const created = await api
      .post('/api/templates')
      .send({ name: 'Not yours', contentJson: { type: 'doc', content: [{ type: 'paragraph' }] } });
    const id = created.body.template.id as string;

    const del = await other.agent.delete(`/api/templates/${id}`);
    expect(del.status).toBe(404);

    // Still there for the real owner.
    const list = await api.get('/api/templates');
    expect((list.body.templates as TemplateDto[]).some((tpl) => tpl.id === id)).toBe(true);
  });
});
