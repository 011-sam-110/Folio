// templates-nb - GET/POST/DELETE /api/templates + built-in template seeding.
// Mounting is the integration captain's job (a one-liner in app.ts).
//
// Ownership model (see schema.sql): a built-in has a NULL user_id and is shared by every
// account; anything a user creates is owned by them. Reads return the caller's own rows
// plus the built-ins; writes and deletes only ever touch rows the caller owns.
//
// Seeding can no longer happen synchronously at import time - the Postgres layer is async
// and the table does not exist until migrate() has run - so it is a memoised promise the
// router awaits before handling its first request.
import { Router } from 'express';
import { db, migrate, newId, nowIso, tx } from '../db.js';
import { userId } from '../auth/middleware.js';

const router = Router();

// Auth is mounted once, in app.ts (`app.use('/api/templates', requireAuth, ...)`), so this
// router does not add its own guard - one layer means one place to audit and one session
// lookup per request. `userId(req)` throws if that mount ever loses the guard, so the
// failure mode is a loud 500, never an unscoped query.

interface TemplateRow {
  id: string;
  user_id: string | null; // NULL = built-in, shared by all users
  name: string;
  emoji: string;
  description: string;
  content_json: string;
  builtin: number;
  created_at: string;
}

function templateDto(row: TemplateRow) {
  return {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    description: row.description,
    contentJson: JSON.parse(row.content_json) as Record<string, unknown>,
    builtin: Boolean(row.builtin),
    createdAt: row.created_at,
  };
}

/** Same structural bar as notes.ts's validator: a minimally-valid TipTap doc, so a
 *  template can never brick the note created from it. Unlike notes (where contentJson is
 *  optional on PATCH), it's REQUIRED here - there's no other field to fall back to. */
function validateContentJson(value: unknown): string | null {
  if (value === undefined) return 'contentJson is required';
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return 'contentJson must be a TipTap document object';
  }
  const doc = value as { type?: unknown; content?: unknown };
  if (doc.type !== 'doc') return "contentJson must have type: 'doc'";
  if (!Array.isArray(doc.content)) return 'contentJson.content must be an array';
  return null;
}

// --- Small TipTap JSON builders, used only to assemble the built-in templates below.
// Kept local (not exported) - this is purely a content-authoring convenience, not a
// general-purpose doc builder other routes should depend on. ------------------------
type TTNode = Record<string, unknown>;

const t = (text: string, marks?: TTNode[]): TTNode => (marks ? { type: 'text', text, marks } : { type: 'text', text });
const bold = (text: string): TTNode => t(text, [{ type: 'bold' }]);
const italic = (text: string): TTNode => t(text, [{ type: 'italic' }]);
const paragraph = (...content: TTNode[]): TTNode => (content.length ? { type: 'paragraph', content } : { type: 'paragraph' });
const heading = (level: number, text: string): TTNode => ({ type: 'heading', attrs: { level }, content: [t(text)] });
const listItem = (...content: TTNode[]): TTNode => ({ type: 'listItem', content: [paragraph(...content)] });
const bulletList = (...items: TTNode[]): TTNode => ({ type: 'bulletList', content: items });
const taskItem = (text: string): TTNode => ({ type: 'taskItem', attrs: { checked: false }, content: [paragraph(t(text))] });
const taskList = (...items: TTNode[]): TTNode => ({ type: 'taskList', content: items });
/** A collapsible "toggle" block (native `@tiptap/extension-details`, persisted open state). */
const toggle = (summary: string, ...content: TTNode[]): TTNode => ({
  type: 'details',
  attrs: { open: true },
  content: [
    { type: 'detailsSummary', content: [t(summary)] },
    { type: 'detailsContent', content },
  ],
});
const callout = (emoji: string, tone: string, ...content: TTNode[]): TTNode => ({ type: 'callout', attrs: { emoji, tone }, content });
// Cross-agent contract (ITER2-PLAN.md): columnList/column, 2-4 columns, attrs.width nullable.
const column = (...content: TTNode[]): TTNode => ({ type: 'column', attrs: { width: null }, content });
const columnList = (...columns: TTNode[]): TTNode => ({ type: 'columnList', content: columns });
const doc = (...content: TTNode[]): TTNode => ({ type: 'doc', content });

function lectureNoteDoc(): TTNode {
  return doc(
    paragraph(bold('Date: '), italic('e.g. 14 Oct 2026')),
    paragraph(bold('Topic: '), italic('e.g. Binary search trees - insertion & balancing')),
    toggle(
      'Key terms',
      bulletList(
        listItem(bold('Term - '), italic('short definition, in your own words')),
        listItem(bold('Term - '), italic('short definition, in your own words')),
        listItem(bold('Term - '), italic('short definition, in your own words')),
      ),
    ),
    heading(2, 'Worked example'),
    paragraph(italic('Walk through one worked example step by step - this is what you’ll actually reread before an exam.')),
    heading(2, 'Questions to review'),
    taskList(
      taskItem('What didn’t fully make sense?'),
      taskItem('Follow up with the lecturer / textbook on…'),
    ),
  );
}

function cornellNotesDoc(): TTNode {
  return doc(
    paragraph(bold('Date: '), italic('e.g. 14 Oct 2026')),
    paragraph(bold('Topic: '), italic('e.g. Binary search trees - insertion & balancing')),
    columnList(
      column(
        heading(3, 'Cues & questions'),
        paragraph(italic('Keywords, questions and prompts you’ll use to test recall later - fill this in AFTER the notes column, ideally after class.')),
      ),
      column(
        heading(3, 'Notes'),
        paragraph(italic('Full notes go here - write in full sentences during the lecture or reading.')),
      ),
    ),
    callout(
      '📝',
      'info',
      paragraph(bold('Summary - '), italic('condense the Notes column into 2-3 sentences here once class is over.')),
    ),
  );
}

/** The built-ins are one shared set for the whole install (user_id NULL), not a per-account
 *  copy, so their ids are fixed rather than generated by newId(). Fixed ids are what make
 *  the seed idempotent via ON CONFLICT: two cold serverless instances booting at once can
 *  both run it without inserting duplicates, which a "is the table empty?" guard could not
 *  guarantee. The numeric prefix preserves the original Lecture-then-Cornell order under the
 *  `id` tiebreak in the list query (Postgres has no rowid to fall back on). */
const BUILTIN_TEMPLATES: Array<{ id: string; name: string; emoji: string; description: string; doc: () => TTNode }> = [
  {
    id: 'builtin-01-lecture-note',
    name: 'Lecture note',
    emoji: '🎓',
    description: 'Date, topic, a key-terms toggle, a worked example and questions to follow up on.',
    doc: lectureNoteDoc,
  },
  {
    id: 'builtin-02-cornell-notes',
    name: 'Cornell notes',
    emoji: '📐',
    description: 'Two-column cue/notes layout with a summary strip - built for active recall.',
    doc: cornellNotesDoc,
  },
];

let seeded: Promise<void> | null = null;

/**
 * Insert the shared built-in templates if they are not already there. Idempotent and
 * de-duplicated per process, so the concurrent requests that hit a cold serverless
 * instance run it once rather than racing each other.
 *
 * Exported so a boot path can warm it eagerly; the router awaits it either way.
 */
export function seedBuiltinTemplates(): Promise<void> {
  seeded ??= (async () => {
    // migrate() is itself idempotent and memoised - this just guarantees the templates
    // table exists before the insert, without depending on app.ts's boot order.
    await migrate();
    const now = nowIso();
    await tx(async (conn) => {
      for (const tpl of BUILTIN_TEMPLATES) {
        // `conn`, not the module-level `db`: `db` would draw a different pooled
        // connection and silently run outside this transaction.
        await conn
          .prepare(
            `INSERT INTO templates (id, user_id, name, emoji, description, content_json, builtin, created_at)
             VALUES (?, NULL, ?, ?, ?, ?, 1, ?)
             ON CONFLICT (id) DO NOTHING`,
          )
          .run(tpl.id, tpl.name, tpl.emoji, tpl.description, JSON.stringify(tpl.doc()), now);
      }
    });
  })().catch((err) => {
    seeded = null; // let a later request retry rather than caching the failure
    throw err;
  });
  return seeded;
}

// Seeding used to run at import time; it now runs on the first request through this router,
// because it needs the schema applied and the DB calls are async.
router.use((_req, _res, next) => {
  seedBuiltinTemplates().then(() => next(), next);
});

// GET /api/templates - the caller's own templates plus the shared built-ins, builtin first,
// then newest.
router.get('/', async (req, res) => {
  const uid = userId(req);
  // `user_id IS NULL` is the built-in row, deliberately visible to everyone; every other
  // row must belong to the caller. Ordering tie-breaks on `id` - the old `rowid ASC` has no
  // Postgres equivalent, and `id` is the real primary key.
  const rows = await db
    .prepare(
      `SELECT * FROM templates
        WHERE user_id = ? OR user_id IS NULL
        ORDER BY builtin DESC, created_at DESC, id ASC`,
    )
    .all<TemplateRow>(uid);
  res.json({ templates: rows.map(templateDto) });
});

// POST /api/templates { name, emoji?, description?, contentJson }
router.post('/', async (req, res) => {
  const uid = userId(req);
  const b = (req.body ?? {}) as { name?: unknown; emoji?: unknown; description?: unknown; contentJson?: unknown };
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  const contentJsonError = validateContentJson(b.contentJson);
  if (contentJsonError) {
    res.status(400).json({ error: contentJsonError });
    return;
  }

  const id = newId();
  const now = nowIso();
  const emoji = typeof b.emoji === 'string' && b.emoji.trim() ? b.emoji.trim() : '📄';
  const description = typeof b.description === 'string' ? b.description.trim() : '';

  // Owner comes from the session only - never from the body, which the client controls.
  await db
    .prepare(
      `INSERT INTO templates (id, user_id, name, emoji, description, content_json, builtin, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .run(id, uid, name, emoji, description, JSON.stringify(b.contentJson), now);

  const row = await db
    .prepare('SELECT * FROM templates WHERE id = ? AND user_id = ?')
    .get<TemplateRow>(id, uid);
  res.status(201).json({ template: templateDto(row!) });
});

// DELETE /api/templates/:id - the caller's own templates only. Built-ins are no longer
// deletable: they have a NULL user_id, so `user_id = ?` never matches one, and deleting a
// shared row would remove it for every other account too. Another user's template falls
// through to the same 404 as a nonexistent id, so ids stay unenumerable.
router.delete('/:id', async (req, res) => {
  const uid = userId(req);
  const result = await db
    .prepare('DELETE FROM templates WHERE id = ? AND user_id = ?')
    .run(req.params.id, uid);
  if (result.changes === 0) {
    res.status(404).json({ error: 'template not found' });
    return;
  }
  res.json({ ok: true });
});

export default router;
