// templates-nb — GET/POST/DELETE /api/templates + boot-time builtin seeding.
// Mounting is the integration captain's job (a one-liner in app.ts); this module seeds
// its builtins as soon as it's imported, since that's the only hook this wave gives us
// into "on boot" without touching seed.ts (which is explicitly out of scope here).
import { Router } from 'express';
import { db, newId, nowIso } from '../db.js';

const router = Router();

interface TemplateRow {
  id: string;
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
 *  optional on PATCH), it's REQUIRED here — there's no other field to fall back to. */
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
// Kept local (not exported) — this is purely a content-authoring convenience, not a
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
    paragraph(bold('Topic: '), italic('e.g. Binary search trees — insertion & balancing')),
    toggle(
      'Key terms',
      bulletList(
        listItem(bold('Term — '), italic('short definition, in your own words')),
        listItem(bold('Term — '), italic('short definition, in your own words')),
        listItem(bold('Term — '), italic('short definition, in your own words')),
      ),
    ),
    heading(2, 'Worked example'),
    paragraph(italic('Walk through one worked example step by step — this is what you’ll actually reread before an exam.')),
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
    paragraph(bold('Topic: '), italic('e.g. Binary search trees — insertion & balancing')),
    columnList(
      column(
        heading(3, 'Cues & questions'),
        paragraph(italic('Keywords, questions and prompts you’ll use to test recall later — fill this in AFTER the notes column, ideally after class.')),
      ),
      column(
        heading(3, 'Notes'),
        paragraph(italic('Full notes go here — write in full sentences during the lecture or reading.')),
      ),
    ),
    callout(
      '📝',
      'info',
      paragraph(bold('Summary — '), italic('condense the Notes column into 2–3 sentences here once class is over.')),
    ),
  );
}

/** Boot-seed: if the templates table is empty, insert the two built-ins. Runs once, as
 *  soon as this module is imported (there's no other server "on boot" hook this wave). */
function seedBuiltinTemplatesIfEmpty(): void {
  const { c } = db.prepare('SELECT COUNT(*) as c FROM templates').get() as { c: number };
  if (c > 0) return;
  const now = nowIso();
  const insert = db.prepare(
    'INSERT INTO templates (id, name, emoji, description, content_json, builtin, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
  );
  insert.run(
    newId(),
    'Lecture note',
    '🎓',
    'Date, topic, a key-terms toggle, a worked example and questions to follow up on.',
    JSON.stringify(lectureNoteDoc()),
    now,
  );
  insert.run(
    newId(),
    'Cornell notes',
    '📐',
    'Two-column cue/notes layout with a summary strip — built for active recall.',
    JSON.stringify(cornellNotesDoc()),
    now,
  );
}

seedBuiltinTemplatesIfEmpty();

// GET /api/templates — builtin first, then newest.
router.get('/', (_req, res) => {
  const rows = db.prepare('SELECT * FROM templates ORDER BY builtin DESC, created_at DESC, rowid ASC').all() as TemplateRow[];
  res.json({ templates: rows.map(templateDto) });
});

// POST /api/templates { name, emoji?, description?, contentJson }
router.post('/', (req, res) => {
  const b = (req.body ?? {}) as { name?: unknown; emoji?: unknown; description?: unknown; contentJson?: unknown };
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'name is required' });

  const contentJsonError = validateContentJson(b.contentJson);
  if (contentJsonError) return res.status(400).json({ error: contentJsonError });

  const id = newId();
  const now = nowIso();
  const emoji = typeof b.emoji === 'string' && b.emoji.trim() ? b.emoji.trim() : '📄';
  const description = typeof b.description === 'string' ? b.description.trim() : '';

  db.prepare(
    'INSERT INTO templates (id, name, emoji, description, content_json, builtin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
  ).run(id, name, emoji, description, JSON.stringify(b.contentJson), now);

  const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow;
  res.status(201).json({ template: templateDto(row) });
});

// DELETE /api/templates/:id — builtins CAN be deleted (user's choice); re-seeded only if
// the table becomes fully empty again on a later boot.
router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM templates WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'template not found' });
  res.json({ ok: true });
});

export default router;
