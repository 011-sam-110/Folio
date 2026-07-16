import { Router } from 'express';
import { db, newId, nowIso } from '../db.js';
import { noteLite, noteFull, wordCountOf, type NoteRow } from '../lib/serialize.js';
import { syncLinksForNote } from '../lib/links.js';
import { tiptapToMarkdown, type TTNode } from '../lib/export.js';

const router = Router();

function getNoteRow(id: string): NoteRow | undefined {
  return db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow | undefined;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, c => `\\${c}`);
}

/** Best-effort plain-text projection of a TipTap doc — fallback when a caller sends
 *  contentJson without contentText, and to regenerate content_text on version restore. */
function plainTextFallback(doc: unknown): string {
  const out: string[] = [];
  function walk(node: unknown): void {
    if (!node || typeof node !== 'object') return;
    const n = node as { type?: string; text?: string; attrs?: Record<string, unknown>; content?: unknown[] };
    if (n.type === 'text') {
      out.push(n.text ?? '');
      return;
    }
    if (n.type === 'wikilink' || n.type === 'wikiLink') {
      out.push(`[[${(n.attrs?.title ?? n.attrs?.label ?? '') as string}]]`);
      return;
    }
    if (n.type === 'hardBreak') {
      out.push('\n');
      return;
    }
    if (Array.isArray(n.content)) for (const c of n.content) walk(c);
    if (n.type && ['paragraph', 'heading', 'listItem', 'taskItem', 'codeBlock', 'tableRow', 'blockquote', 'detailsSummary'].includes(n.type)) {
      out.push('\n');
    }
  }
  walk(doc);
  return out.join('').replace(/\n{2,}/g, '\n').trim();
}

function setTags(noteId: string, tags: unknown): void {
  const list = Array.isArray(tags) ? [...new Set(tags.map(t => String(t).trim()).filter(Boolean))] : [];
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM note_tags WHERE note_id = ?').run(noteId);
    const stmt = db.prepare('INSERT OR IGNORE INTO note_tags (note_id, tag) VALUES (?, ?)');
    for (const t of list) stmt.run(noteId, t);
  });
  tx();
}

function insertVersion(noteId: string, title: string, contentJson: string, cause: string, label: string | null = null): void {
  db.prepare('INSERT INTO note_versions (note_id, title, content_json, cause, label, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    noteId,
    title,
    contentJson,
    cause,
    label,
    nowIso(),
  );
}

function shouldAutosaveSnapshot(noteId: string): boolean {
  const latest = db
    .prepare('SELECT cause, created_at FROM note_versions WHERE note_id = ? ORDER BY created_at DESC, id DESC LIMIT 1')
    .get(noteId) as { cause: string; created_at: string } | undefined;
  if (!latest) return true;
  if (latest.cause !== 'autosave') return true;
  const age = Date.now() - new Date(latest.created_at).getTime();
  return age > 10 * 60 * 1000;
}

interface VersionRow {
  id: number;
  title: string;
  content_json: string;
  cause: string;
  label: string | null;
  created_at: string;
}

function versionMeta(v: VersionRow) {
  return {
    id: v.id,
    cause: v.cause,
    label: v.label,
    createdAt: v.created_at,
    title: v.title,
    wordCount: wordCountOf(plainTextFallback(JSON.parse(v.content_json))),
  };
}

// --- Collection routes (must come before /:id) ---------------------------------

router.get('/recent', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 12, 1), 100);
  const rows = db.prepare('SELECT * FROM notes WHERE archived = 0 ORDER BY updated_at DESC LIMIT ?').all(limit) as NoteRow[];
  res.json({ notes: rows.map(noteLite) });
});

router.get('/', (req, res) => {
  const notebookId = typeof req.query.notebookId === 'string' ? req.query.notebookId : undefined;
  const tag = typeof req.query.tag === 'string' ? req.query.tag : undefined;
  const archived = req.query.archived !== undefined ? String(req.query.archived) === '1' : false;
  const sort = typeof req.query.sort === 'string' ? req.query.sort : 'updated';
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const conditions = ['n.archived = ?'];
  const conditionParams: unknown[] = [archived ? 1 : 0];
  if (notebookId) {
    conditions.push('n.notebook_id = ?');
    conditionParams.push(notebookId);
  }
  const join = tag ? 'JOIN note_tags nt ON nt.note_id = n.id AND nt.tag = ?' : '';
  const params = tag ? [tag, ...conditionParams] : conditionParams;

  const orderBy = sort === 'created' ? 'n.created_at DESC' : sort === 'title' ? 'n.title COLLATE NOCASE ASC' : 'n.updated_at DESC';
  const whereSql = conditions.join(' AND ');

  const rows = db
    .prepare(`SELECT n.* FROM notes n ${join} WHERE ${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as NoteRow[];
  const total = (db.prepare(`SELECT COUNT(*) as c FROM notes n ${join} WHERE ${whereSql}`).get(...params) as { c: number }).c;

  res.json({ notes: rows.map(noteLite), total });
});

router.post('/', (req, res) => {
  const b = req.body ?? {};
  if (typeof b.notebookId !== 'string' || !b.notebookId) return res.status(400).json({ error: 'notebookId is required' });
  const notebook = db.prepare('SELECT id FROM notebooks WHERE id = ?').get(b.notebookId);
  if (!notebook) return res.status(400).json({ error: 'unknown notebookId' });

  const id = newId();
  const now = nowIso();
  const title = b.title !== undefined ? String(b.title) : '';
  const contentJsonObj = b.contentJson !== undefined ? b.contentJson : { type: 'doc', content: [{ type: 'paragraph' }] };
  const contentJson = JSON.stringify(contentJsonObj);
  const contentText = b.contentText !== undefined ? String(b.contentText) : b.contentJson !== undefined ? plainTextFallback(contentJsonObj) : '';

  db.prepare(
    `INSERT INTO notes (id, notebook_id, title, content_json, content_text, pinned, archived, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)`,
  ).run(id, b.notebookId, title, contentJson, contentText, now, now);

  if (b.tags !== undefined) setTags(id, b.tags);
  if (contentText) syncLinksForNote(id, contentText);

  const row = getNoteRow(id)!;
  res.status(201).json({ note: noteFull(row) });
});

// --- Single-note routes ----------------------------------------------------------

router.get('/:id', (req, res) => {
  const row = getNoteRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'note not found' });

  const backlinkRows = db
    .prepare('SELECT n.* FROM links l JOIN notes n ON n.id = l.from_note_id WHERE l.to_note_id = ? ORDER BY n.updated_at DESC')
    .all(row.id) as NoteRow[];
  const outgoingRows = db
    .prepare('SELECT n.* FROM links l JOIN notes n ON n.id = l.to_note_id WHERE l.from_note_id = ? ORDER BY n.updated_at DESC')
    .all(row.id) as NoteRow[];

  res.json({ note: noteFull(row), backlinks: backlinkRows.map(noteLite), outgoingLinks: outgoingRows.map(noteLite) });
});

router.patch('/:id', (req, res) => {
  const row = getNoteRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'note not found' });

  const b = req.body ?? {};
  if (b.notebookId !== undefined) {
    const notebook = db.prepare('SELECT id FROM notebooks WHERE id = ?').get(b.notebookId);
    if (!notebook) return res.status(400).json({ error: 'unknown notebookId' });
  }

  const contentChanging = b.title !== undefined || b.contentJson !== undefined || b.contentText !== undefined;
  if (contentChanging && shouldAutosaveSnapshot(row.id)) {
    insertVersion(row.id, row.title, row.content_json, 'autosave');
  }

  const newTitle = b.title !== undefined ? String(b.title) : row.title;
  const newContentJson = b.contentJson !== undefined ? JSON.stringify(b.contentJson) : row.content_json;
  const newContentText =
    b.contentText !== undefined
      ? String(b.contentText)
      : b.contentJson !== undefined
        ? plainTextFallback(b.contentJson)
        : row.content_text;
  const newPinned = b.pinned !== undefined ? (b.pinned ? 1 : 0) : row.pinned;
  const newArchived = b.archived !== undefined ? (b.archived ? 1 : 0) : row.archived;
  const newNotebookId = b.notebookId !== undefined ? b.notebookId : row.notebook_id;

  db.prepare('UPDATE notes SET title = ?, content_json = ?, content_text = ?, pinned = ?, archived = ?, notebook_id = ?, updated_at = ? WHERE id = ?').run(
    newTitle,
    newContentJson,
    newContentText,
    newPinned,
    newArchived,
    newNotebookId,
    nowIso(),
    row.id,
  );

  if (b.tags !== undefined) setTags(row.id, b.tags);
  if (b.contentText !== undefined || b.contentJson !== undefined) syncLinksForNote(row.id, newContentText);

  const updated = getNoteRow(row.id)!;
  res.json({ note: noteFull(updated) });
});

router.delete('/:id', (req, res) => {
  const row = getNoteRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'note not found' });
  db.prepare('DELETE FROM notes WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

router.get('/:id/versions', (req, res) => {
  const note = getNoteRow(req.params.id);
  if (!note) return res.status(404).json({ error: 'note not found' });
  const rows = db
    .prepare('SELECT id, title, content_json, cause, label, created_at FROM note_versions WHERE note_id = ? ORDER BY created_at DESC, id DESC')
    .all(note.id) as VersionRow[];
  res.json({ versions: rows.map(versionMeta) });
});

router.get('/:id/versions/:vid', (req, res) => {
  const note = getNoteRow(req.params.id);
  if (!note) return res.status(404).json({ error: 'note not found' });
  const v = db
    .prepare('SELECT id, title, content_json, cause, label, created_at FROM note_versions WHERE id = ? AND note_id = ?')
    .get(req.params.vid, note.id) as VersionRow | undefined;
  if (!v) return res.status(404).json({ error: 'version not found' });
  res.json({ version: { id: v.id, title: v.title, contentJson: JSON.parse(v.content_json), cause: v.cause, label: v.label, createdAt: v.created_at } });
});

router.post('/:id/versions', (req, res) => {
  const note = getNoteRow(req.params.id);
  if (!note) return res.status(404).json({ error: 'note not found' });
  const label = typeof req.body?.label === 'string' && req.body.label.trim() ? req.body.label.trim() : null;
  insertVersion(note.id, note.title, note.content_json, 'manual', label);
  const v = db
    .prepare('SELECT id, title, content_json, cause, label, created_at FROM note_versions WHERE note_id = ? ORDER BY id DESC LIMIT 1')
    .get(note.id) as VersionRow;
  res.status(201).json({ version: versionMeta(v) });
});

router.post('/:id/restore/:vid', (req, res) => {
  const note = getNoteRow(req.params.id);
  if (!note) return res.status(404).json({ error: 'note not found' });
  const v = db.prepare('SELECT id, title, content_json FROM note_versions WHERE id = ? AND note_id = ?').get(req.params.vid, note.id) as
    | { id: number; title: string; content_json: string }
    | undefined;
  if (!v) return res.status(404).json({ error: 'version not found' });

  insertVersion(note.id, note.title, note.content_json, 'restore');

  const restoredContentText = plainTextFallback(JSON.parse(v.content_json));
  db.prepare('UPDATE notes SET title = ?, content_json = ?, content_text = ?, updated_at = ? WHERE id = ?').run(
    v.title,
    v.content_json,
    restoredContentText,
    nowIso(),
    note.id,
  );
  syncLinksForNote(note.id, restoredContentText);

  const updated = getNoteRow(note.id)!;
  res.json({ note: noteFull(updated) });
});

router.get('/:id/export', (req, res) => {
  const note = getNoteRow(req.params.id);
  if (!note) return res.status(404).json({ error: 'note not found' });
  const format = typeof req.query.format === 'string' ? req.query.format : 'markdown';
  if (format !== 'markdown') return res.status(400).json({ error: 'unsupported export format' });

  const markdown = tiptapToMarkdown(JSON.parse(note.content_json) as TTNode);
  const safeName = (note.title || 'untitled').replace(/[^a-z0-9\-_ ]/gi, '').trim().replace(/\s+/g, '-').slice(0, 80) || 'untitled';

  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.md"`);
  res.send(markdown);
});

router.get('/:id/unlinked-mentions', (req, res) => {
  const note = getNoteRow(req.params.id);
  if (!note) return res.status(404).json({ error: 'note not found' });
  if (!note.title.trim()) return res.json({ notes: [] });

  const linkedIds = new Set(
    (db.prepare('SELECT from_note_id FROM links WHERE to_note_id = ?').all(note.id) as Array<{ from_note_id: string }>).map(r => r.from_note_id),
  );

  const candidates = db
    .prepare(`SELECT * FROM notes WHERE id != ? AND archived = 0 AND lower(content_text) LIKE lower(?) ESCAPE '\\'`)
    .all(note.id, `%${escapeLike(note.title)}%`) as NoteRow[];

  const filtered = candidates.filter(c => !linkedIds.has(c.id));
  res.json({ notes: filtered.map(noteLite) });
});

export default router;
