import { Router } from 'express';
import { db } from '../db.js';
import { noteLite, wordCountOf, type NoteRow } from '../lib/serialize.js';

const router = Router();

router.get('/', (_req, res) => {
  const recentRows = db.prepare('SELECT * FROM notes WHERE archived = 0 ORDER BY updated_at DESC LIMIT 8').all() as NoteRow[];
  const pinnedRows = db.prepare('SELECT * FROM notes WHERE archived = 0 AND pinned = 1 ORDER BY updated_at DESC').all() as NoteRow[];
  const continueRow = recentRows[0] ?? null;

  const notes = (db.prepare('SELECT COUNT(*) as c FROM notes WHERE archived = 0').get() as { c: number }).c;
  const notebooks = (db.prepare('SELECT COUNT(*) as c FROM notebooks').get() as { c: number }).c;
  const texts = db.prepare('SELECT content_text FROM notes WHERE archived = 0').all() as Array<{ content_text: string }>;
  const words = texts.reduce((sum, r) => sum + wordCountOf(r.content_text), 0);
  const flashcardsDue = (db.prepare('SELECT COUNT(*) as c FROM flashcards WHERE suspended = 0 AND due_at <= ?').get(new Date().toISOString()) as {
    c: number;
  }).c;

  // Last 14 days (UTC), edits per day sourced from both note_versions and notes.updated_at
  // so an in-progress note (no version yet) still shows up as activity today.
  const days: string[] = [];
  const today = new Date();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    d.setUTCDate(d.getUTCDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  const counts = new Map<string, number>(days.map(d => [d, 0]));
  const since = `${days[0]}T00:00:00.000Z`;

  const versionDates = db.prepare('SELECT created_at FROM note_versions WHERE created_at >= ?').all(since) as Array<{ created_at: string }>;
  for (const v of versionDates) {
    const day = v.created_at.slice(0, 10);
    if (counts.has(day)) counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const noteUpdateDates = db.prepare('SELECT updated_at FROM notes WHERE updated_at >= ?').all(since) as Array<{ updated_at: string }>;
  for (const n of noteUpdateDates) {
    const day = n.updated_at.slice(0, 10);
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
    const stats = db.prepare('SELECT COUNT(*) as c, MAX(updated_at) as last FROM notes WHERE notebook_id = ? AND archived = 0').get(nb.id) as {
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
