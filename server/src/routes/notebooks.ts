import { Router } from 'express';
import { db, newId, nowIso } from '../db.js';

const router = Router();

interface NotebookRow {
  id: string;
  name: string;
  emoji: string;
  color: string;
  position: number;
  archived: number;
  created_at: string;
}

const getRowStmt = () => db.prepare('SELECT * FROM notebooks WHERE id = ?');
const statsStmt = () => db.prepare('SELECT COUNT(*) as c, MAX(updated_at) as last FROM notes WHERE notebook_id = ? AND archived = 0 AND deleted_at IS NULL');

function notebookOut(row: NotebookRow) {
  const stats = statsStmt().get(row.id) as { c: number; last: string | null };
  return {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    color: row.color,
    position: row.position,
    archived: Boolean(row.archived),
    noteCount: stats.c,
    lastNoteAt: stats.last,
  };
}

router.get('/', (_req, res) => {
  const rows = db.prepare('SELECT * FROM notebooks ORDER BY position ASC, created_at ASC').all() as NotebookRow[];
  res.json({ notebooks: rows.map(notebookOut) });
});

router.post('/', (req, res) => {
  const b = req.body ?? {};
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'name is required' });

  const id = newId();
  const now = nowIso();
  const maxPos = (db.prepare('SELECT COALESCE(MAX(position), -1) as m FROM notebooks').get() as { m: number }).m;

  db.prepare(
    'INSERT INTO notebooks (id, name, emoji, color, position, archived, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
  ).run(id, name, typeof b.emoji === 'string' && b.emoji ? b.emoji : '📓', typeof b.color === 'string' && b.color ? b.color : '#6366f1', maxPos + 1, now);

  const row = getRowStmt().get(id) as NotebookRow;
  res.status(201).json({ notebook: notebookOut(row) });
});

router.patch('/:id', (req, res) => {
  const row = getRowStmt().get(req.params.id) as NotebookRow | undefined;
  if (!row) return res.status(404).json({ error: 'notebook not found' });

  const b = req.body ?? {};
  if (b.name !== undefined && !String(b.name).trim()) return res.status(400).json({ error: 'name cannot be empty' });

  db.prepare('UPDATE notebooks SET name = ?, emoji = ?, color = ?, position = ?, archived = ? WHERE id = ?').run(
    b.name !== undefined ? String(b.name).trim() : row.name,
    b.emoji !== undefined ? String(b.emoji) : row.emoji,
    b.color !== undefined ? String(b.color) : row.color,
    b.position !== undefined ? Number(b.position) : row.position,
    b.archived !== undefined ? (b.archived ? 1 : 0) : row.archived,
    row.id,
  );

  const updated = getRowStmt().get(row.id) as NotebookRow;
  res.json({ notebook: notebookOut(updated) });
});

router.delete('/:id', (req, res) => {
  const row = getRowStmt().get(req.params.id) as NotebookRow | undefined;
  if (!row) return res.status(404).json({ error: 'notebook not found' });
  db.prepare('DELETE FROM notebooks WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

export default router;
