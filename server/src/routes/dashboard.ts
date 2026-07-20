import { Router } from 'express';
import { db, nowIso } from '../db.js';
import { noteLite, wordCountOf, type NoteRow } from '../lib/serialize.js';

const router = Router();

/** Local-timezone 'YYYY-MM-DD' for a Date (server machine's local day, not UTC). */
function localDayStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Local midnight of the Monday starting the week containing `d`. getDay() is 0=Sun..6=Sat;
 *  (day+6)%7 turns that into 0=Mon..6=Sun so we can step back to Monday in local time. */
function mondayOfWeek(d: Date): Date {
  const diffToMonday = (d.getDay() + 6) % 7;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - diffToMonday, 0, 0, 0, 0);
}

interface TinyNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: TinyNode[];
}

function textOf(node: TinyNode): string {
  if (node.type === 'text' && typeof node.text === 'string') return node.text;
  if (Array.isArray(node.content)) return node.content.map(textOf).join('');
  return '';
}

/** A note "has a summary" if it contains an h2 heading literally titled "Summary" (any
 *  case) or a callout block anywhere (AI Summarize inserts a callout headed "Summary";
 *  a manually-added callout of any tone still counts as the student having flagged the
 *  key point some other way). Used for the weekly-review "notes worth summarizing" nudge. */
function hasSummaryMarker(node: TinyNode | null | undefined): boolean {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'callout') return true;
  if (node.type === 'heading' && Number(node.attrs?.level) === 2 && textOf(node).trim().toLowerCase() === 'summary') {
    return true;
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      if (hasSummaryMarker(child)) return true;
    }
  }
  return false;
}

router.get('/', (_req, res) => {
  const now = nowIso();

  const recentRows = db.prepare('SELECT * FROM notes WHERE archived = 0 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 8').all() as NoteRow[];
  const pinnedRows = db.prepare('SELECT * FROM notes WHERE archived = 0 AND deleted_at IS NULL AND pinned = 1 ORDER BY updated_at DESC').all() as NoteRow[];
  const continueRow = recentRows[0] ?? null;

  const notes = (db.prepare('SELECT COUNT(*) as c FROM notes WHERE archived = 0 AND deleted_at IS NULL').get() as { c: number }).c;
  const notebooks = (db.prepare('SELECT COUNT(*) as c FROM notebooks').get() as { c: number }).c;
  const activeBodies = db.prepare('SELECT content_text, content_json FROM notes WHERE archived = 0 AND deleted_at IS NULL').all() as Array<{
    content_text: string;
    content_json: string;
  }>;
  const words = activeBodies.reduce((sum, r) => sum + wordCountOf(r.content_text), 0);
  const flashcardsDue = (db.prepare('SELECT COUNT(*) as c FROM flashcards WHERE suspended = 0 AND due_at <= ?').get(now) as {
    c: number;
  }).c;

  // Last 14 days bucketed by the server's LOCAL day (a UK student reviewing at 00:30 BST
  // should count toward that local day, not the previous UTC one). Stored timestamps are
  // UTC ISO; we convert each to its local day before bucketing.
  const days: string[] = [];
  const nowDate = new Date();
  const earliestLocalStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() - 13, 0, 0, 0, 0);
  for (let i = 13; i >= 0; i--) {
    days.push(localDayStr(new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() - i)));
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

  // --- iteration 2: this-week Mon-Sun grid, per non-archived notebook ------------------
  const weekStart = mondayOfWeek(nowDate);
  const weekDayDates: Date[] = Array.from({ length: 7 }, (_, i) => new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + i));
  const weekDayKeys = weekDayDates.map(localDayStr);
  const weekStartIso = weekStart.toISOString();
  const weekEndIso = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 7).toISOString();

  const nbMeta = new Map(notebookRows.map(nb => [nb.id, nb]));
  const dayTotals = new Map<string, number>(weekDayKeys.map(d => [d, 0]));
  const dayByNotebook = new Map<string, Map<string, number>>(weekDayKeys.map(d => [d, new Map<string, number>()]));

  function tallyActivity(ts: string, notebookId: string | null | undefined): void {
    if (!notebookId || !nbMeta.has(notebookId)) return; // scope to active (non-archived) notebooks only
    const day = localDayStr(new Date(ts));
    if (!dayTotals.has(day)) return; // guards a tz edge case at the week boundary
    dayTotals.set(day, (dayTotals.get(day) ?? 0) + 1);
    const perNb = dayByNotebook.get(day)!;
    perNb.set(notebookId, (perNb.get(notebookId) ?? 0) + 1);
  }

  const weekVersionRows = db
    .prepare('SELECT nv.created_at as ts, n.notebook_id as nid FROM note_versions nv JOIN notes n ON n.id = nv.note_id WHERE nv.created_at >= ? AND nv.created_at < ?')
    .all(weekStartIso, weekEndIso) as Array<{ ts: string; nid: string }>;
  for (const r of weekVersionRows) tallyActivity(r.ts, r.nid);

  const weekUpdatedRows = db
    .prepare('SELECT updated_at as ts, notebook_id as nid FROM notes WHERE deleted_at IS NULL AND updated_at >= ? AND updated_at < ?')
    .all(weekStartIso, weekEndIso) as Array<{ ts: string; nid: string }>;
  for (const r of weekUpdatedRows) tallyActivity(r.ts, r.nid);

  const weekCreatedRows = db
    .prepare('SELECT created_at as ts, notebook_id as nid FROM notes WHERE deleted_at IS NULL AND created_at >= ? AND created_at < ?')
    .all(weekStartIso, weekEndIso) as Array<{ ts: string; nid: string }>;
  for (const r of weekCreatedRows) tallyActivity(r.ts, r.nid);

  const weekGrid = weekDayKeys.map((date, i) => {
    const byNotebook = [...(dayByNotebook.get(date) ?? new Map())]
      .map(([id, count]) => {
        const nb = nbMeta.get(id)!;
        return { id, emoji: nb.emoji, color: nb.color, count };
      })
      .sort((a, b) => b.count - a.count);
    return { date, dayLabel: DAY_LABELS[i], total: dayTotals.get(date) ?? 0, byNotebook };
  });

  // --- iteration 2: weekly review checklist -------------------------------------------
  const notesEditedThisWeek = (
    db.prepare('SELECT COUNT(*) as c FROM notes WHERE archived = 0 AND deleted_at IS NULL AND updated_at >= ?').get(weekStartIso) as { c: number }
  ).c;

  let notesWithoutSummary = 0;
  for (const body of activeBodies) {
    if (wordCountOf(body.content_text) <= 200) continue;
    let doc: TinyNode | null = null;
    try {
      doc = JSON.parse(body.content_json) as TinyNode;
    } catch {
      doc = null;
    }
    if (!hasSummaryMarker(doc)) notesWithoutSummary++;
  }

  const unresolvedComments = (
    db
      .prepare('SELECT COUNT(*) as c FROM note_comments c JOIN notes n ON n.id = c.note_id WHERE c.resolved = 0 AND n.archived = 0 AND n.deleted_at IS NULL')
      .get() as { c: number }
  ).c;

  const dueByNotebook = db
    .prepare(
      `SELECT nb.name as name, COUNT(*) as due
       FROM flashcards f
       JOIN notes n ON n.id = f.note_id
       JOIN notebooks nb ON nb.id = n.notebook_id
       WHERE f.suspended = 0 AND f.due_at <= ? AND n.archived = 0 AND n.deleted_at IS NULL AND nb.archived = 0
       GROUP BY nb.id
       ORDER BY due DESC`,
    )
    .all(now) as Array<{ name: string; due: number }>;

  const suggestions: string[] = [];
  for (const row of dueByNotebook.slice(0, 2)) {
    suggestions.push(`${row.name} has ${row.due} card${row.due === 1 ? '' : 's'} due — 10 min review?`);
  }
  if (notesWithoutSummary > 0) {
    suggestions.push(`${notesWithoutSummary} long note${notesWithoutSummary === 1 ? '' : 's'} could use a Summary — try AI Summarize.`);
  }
  if (unresolvedComments > 0) {
    suggestions.push(`${unresolvedComments} margin comment${unresolvedComments === 1 ? '' : 's'} waiting on a decision.`);
  }
  if (notesEditedThisWeek === 0) {
    suggestions.push(`No notes touched yet this week — pick one up to keep the streak alive.`);
  }

  const weeklyReview = {
    notesEditedThisWeek,
    flashcardsDue,
    notesWithoutSummary,
    unresolvedComments,
    suggestions: suggestions.slice(0, 4),
  };

  // --- iteration 2: per-notebook recall + mini self-test ------------------------------
  const recall = notebookRows
    .map(nb => {
      const lastNoteRow = db
        .prepare('SELECT * FROM notes WHERE notebook_id = ? AND archived = 0 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1')
        .get(nb.id) as NoteRow | undefined;
      const lastNote = lastNoteRow ? noteLite(lastNoteRow) : null;
      const daysSince = lastNoteRow ? Math.floor((Date.now() - new Date(lastNoteRow.updated_at).getTime()) / 86_400_000) : null;

      // Quiz pick: the oldest-due card for this notebook if one exists, else a random
      // (non-suspended) card from the notebook so there's still something to self-test on.
      const dueCard = db
        .prepare(
          `SELECT f.id as id, f.question as question, f.answer as answer
           FROM flashcards f JOIN notes n ON n.id = f.note_id
           WHERE n.notebook_id = ? AND n.archived = 0 AND n.deleted_at IS NULL AND f.suspended = 0 AND f.due_at <= ?
           ORDER BY f.due_at ASC LIMIT 1`,
        )
        .get(nb.id, now) as { id: string; question: string; answer: string } | undefined;
      const randomCard = dueCard
        ? undefined
        : (db
            .prepare(
              `SELECT f.id as id, f.question as question, f.answer as answer
               FROM flashcards f JOIN notes n ON n.id = f.note_id
               WHERE n.notebook_id = ? AND n.archived = 0 AND n.deleted_at IS NULL AND f.suspended = 0
               ORDER BY RANDOM() LIMIT 1`,
            )
            .get(nb.id) as { id: string; question: string; answer: string } | undefined);
      const quizRow = dueCard ?? randomCard;
      const quiz = quizRow ? { cardId: quizRow.id, question: quizRow.question, answer: quizRow.answer } : null;

      return {
        notebook: { id: nb.id, name: nb.name, emoji: nb.emoji, color: nb.color },
        lastNote,
        daysSince,
        quiz,
      };
    })
    .sort((a, b) => (b.daysSince ?? -1) - (a.daysSince ?? -1))
    .slice(0, 6);

  res.json({
    recent: recentRows.map(noteLite),
    pinned: pinnedRows.map(noteLite),
    continueNote: continueRow ? noteLite(continueRow) : null,
    stats: { notes, notebooks, words, flashcardsDue },
    weekActivity,
    notebooks: notebooksOut,
    weekGrid,
    weeklyReview,
    recall,
  });
});

export default router;
