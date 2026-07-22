import { Router } from 'express';
import { db, newId, nowIso } from '../db.js';
import { userId } from '../auth/middleware.js';

const router = Router();

interface NotebookRow {
  id: string;
  user_id: string;
  name: string;
  emoji: string;
  color: string;
  position: number;
  archived: number;
  created_at: string;
}

// Ownership is folded into the lookup itself rather than checked afterwards, so a
// notebook belonging to someone else is indistinguishable from one that does not
// exist (404) - and no handler can forget the check.
const getRowStmt = () => db.prepare('SELECT * FROM notebooks WHERE id = ? AND user_id = ?');
// notes.user_id is redundant with the already-owner-checked notebook_id, but keeping
// it means a mis-filed row could never inflate another user's counts.
const statsStmt = () => db.prepare('SELECT COUNT(*) as c, MAX(updated_at) as last FROM notes WHERE notebook_id = ? AND user_id = ? AND archived = 0 AND deleted_at IS NULL');

async function notebookOut(row: NotebookRow, uid: string) {
  const stats = (await statsStmt().get(row.id, uid)) as { c: number; last: string | null };
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

router.get('/', async (req, res) => {
  const uid = userId(req);
  const rows = (await db
    .prepare('SELECT * FROM notebooks WHERE user_id = ? ORDER BY position ASC, created_at ASC')
    .all(uid)) as NotebookRow[];
  res.json({ notebooks: await Promise.all(rows.map((row) => notebookOut(row, uid))) });
});

router.post('/', async (req, res) => {
  const uid = userId(req);
  const b = req.body ?? {};
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  const id = newId();
  const now = nowIso();
  // Positions are per-user, so the next slot is the max within this user's own list.
  const maxPos = ((await db
    .prepare('SELECT COALESCE(MAX(position), -1) as m FROM notebooks WHERE user_id = ?')
    .get(uid)) as { m: number }).m;

  // The owner comes from the session only - never from the request body.
  await db.prepare(
    'INSERT INTO notebooks (id, user_id, name, emoji, color, position, archived, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
  ).run(id, uid, name, typeof b.emoji === 'string' && b.emoji ? b.emoji : '📓', typeof b.color === 'string' && b.color ? b.color : '#6366f1', maxPos + 1, now);

  const row = (await getRowStmt().get(id, uid)) as NotebookRow;
  res.status(201).json({ notebook: await notebookOut(row, uid) });
});

router.patch('/:id', async (req, res) => {
  const uid = userId(req);
  const row = (await getRowStmt().get(req.params.id, uid)) as NotebookRow | undefined;
  if (!row) {
    res.status(404).json({ error: 'notebook not found' });
    return;
  }

  const b = req.body ?? {};
  if (b.name !== undefined && !String(b.name).trim()) {
    res.status(400).json({ error: 'name cannot be empty' });
    return;
  }

  // user_id is repeated in the WHERE clause even though the row was just fetched by
  // owner: it keeps the ownership guarantee on the statement that actually writes.
  await db.prepare('UPDATE notebooks SET name = ?, emoji = ?, color = ?, position = ?, archived = ? WHERE id = ? AND user_id = ?').run(
    b.name !== undefined ? String(b.name).trim() : row.name,
    b.emoji !== undefined ? String(b.emoji) : row.emoji,
    b.color !== undefined ? String(b.color) : row.color,
    b.position !== undefined ? Number(b.position) : row.position,
    // archived is INTEGER 0/1 in Postgres, which rejects a JS boolean - coerce here.
    b.archived !== undefined ? (b.archived ? 1 : 0) : row.archived,
    row.id,
    uid,
  );

  const updated = (await getRowStmt().get(row.id, uid)) as NotebookRow;
  res.json({ notebook: await notebookOut(updated, uid) });
});

router.delete('/:id', async (req, res) => {
  const uid = userId(req);
  const row = (await getRowStmt().get(req.params.id, uid)) as NotebookRow | undefined;
  if (!row) {
    res.status(404).json({ error: 'notebook not found' });
    return;
  }
  await db.prepare('DELETE FROM notebooks WHERE id = ? AND user_id = ?').run(row.id, uid);
  res.json({ ok: true });
});

export default router;
