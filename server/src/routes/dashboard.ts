import { Router } from 'express';
import { db } from '../db.js';
import { noteLite, wordCountOf, type NoteRow } from '../lib/serialize.js';

const router = Router();

/** Local-timezone 'YYYY-MM-DD' for a Date (server machine's local day, not UTC). */
function localDayStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

router.get('/', (_req, res) => {
  const recentRows = db.prepare('SELECT * FROM notes WHERE archived = 0 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 8').all() as NoteRow[];
  const pinnedRows = db.prepare('SELECT * FROM notes WHERE archived = 0 AND deleted_at IS NULL AND pinned = 1 ORDER BY updated_at DESC').all() as NoteRow[];
  const continueRow = recentRows[0] ?? null;

  const notes = (db.prepare('SELECT COUNT(*) as c FROM notes WHERE archived = 0 AND deleted_at IS NULL').get() as { c: number }).c;
  const notebooks = (db.prepare('SELECT COUNT(*) as c FROM notebooks').get() as { c: number }).c;
  const texts = db.prepare('SELECT content_text FROM notes WHERE archived = 0 AND deleted_at IS NULL').all() as Array<{ content_text: string }>;
  const words = texts.reduce((sum, r) => sum + wordCountOf(r.content_text), 0);
  const flashcardsDue = (db.prepare('SELECT COUNT(*) as c FROM flashcards WHERE suspended = 0 AND due_at <= ?').get(new Date().toISOString()) as {
    c: number;
  }).c;

  // Last 14 days bucketed by the server's LOCAL day (a UK student reviewing at 00:30 BST
  // should count toward that local day, not the previous UTC one). Stored timestamps are
  // UTC ISO; we convert each to its local day before bucketing.
  const days: string[] = [];
  const now = new Date();
  const earliestLocalStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 13, 0, 0, 0, 0);
  for (let i = 13; i >= 0; i--) {
    days.push(localDayStr(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));
  }
  const counts = new Map<string, number>(days.map(d => [d, 0]));
  const since = earliestLocalStart.toISOString(); // UTC lower bound covering the earliest local day

  const versionDates = db.prepare('SELECT created_at FROM note_versions WHERE created_at >= ?').all(since) as Array<{ created_at: string }>;
  for (const v of versionDates) {
    const day = localDayStr(new Date(v.created_at));
    if (counts.has(day)) counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const noteUpdateDates = db.prepare('SELECT updated_at FROM notes WHERE updated_at >= ? AND deleted_at IS NULL').all(since) as Array<{ updated_at: string }>;
  for (const n of noteUpdateDates) {
    const day = localDayStr(new Date(n.updated_at));
    if (counts.has(day)) counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const weekActivity = days.map(date => ({ date, count: counts.get(date) ?? 0 }));

  const notebookRows = db.prepare('SELECT id, name, emoji, color FROM notebooks WHERE archived = 0 ORDER BY position ASC').all() as Array<{
    id: string;
    name: string;
    emoji: string;
    color: string;
  }>;
  const notebooksOut = notebookRows.map(nb => {
    const stats = db.prepare('SELECT COUNT(*) as c, MAX(updated_at) as last FROM notes WHERE notebook_id = ? AND archived = 0 AND deleted_at IS NULL').get(nb.id) as {
      c: number;
      last: string | null;
    };
    return { id: nb.id, name: nb.name, emoji: nb.emoji, color: nb.color, noteCount: stats.c, lastNoteAt: stats.last };
  });

  res.json({
    recent: recentRows.map(noteLite),
    pinned: pinnedRows.map(noteLite),
    continueNote: continueRow ? noteLite(continueRow) : null,
    stats: { notes, notebooks, words, flashcardsDue },
    weekActivity,
    notebooks: notebooksOut,
  });
});

export default router;
