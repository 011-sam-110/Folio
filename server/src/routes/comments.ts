import { Router } from 'express';
import { db, newId, nowIso } from '../db.js';
import { userId } from '../auth/middleware.js';

/**
 * Margin comments — self-annotations anchored to a span of a note.
 *
 * This router did not exist. The table, the client calls, the selection-toolbar
 * button, the comments panel and the dashboard's "unresolved comments" counter
 * were all shipped, and every one of them hit the API catch-all: two 404s on every
 * note open, and a red toast reading `not found` if you tried to leave a comment.
 * The feature was fully built except for the part that stores anything.
 *
 * note_comments carries no user_id, so ownership is enforced by reaching through
 * `notes` on every statement — an INSERT…SELECT on the write side and a join on the
 * read side. A bare `WHERE note_id = ?` here would let any signed-in user read or
 * annotate someone else's note by guessing an id.
 */
const router = Router();

interface CommentRow {
  id: string;
  note_id: string;
  anchor_text: string;
  body: string;
  resolved: number;
  created_at: string;
  updated_at: string;
}

const MAX_BODY = 5_000;
const MAX_ANCHOR = 200;

function serialize(r: CommentRow) {
  return {
    id: r.id,
    noteId: r.note_id,
    anchorText: r.anchor_text,
    body: r.body,
    resolved: r.resolved === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** GET /api/notes/:noteId/comments */
router.get('/notes/:noteId/comments', async (req, res) => {
  const uid = userId(req);
  const rows = await db
    .prepare(
      `SELECT c.* FROM note_comments c
         JOIN notes n ON n.id = c.note_id AND n.user_id = ?
        WHERE c.note_id = ?
        ORDER BY c.created_at ASC`,
    )
    .all<CommentRow>(uid, req.params.noteId);
  res.json({ comments: rows.map(serialize) });
});

/** POST /api/notes/:noteId/comments */
router.post('/notes/:noteId/comments', async (req, res) => {
  const uid = userId(req);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const body = String(b.body ?? '').trim();
  if (!body) {
    res.status(400).json({ error: 'Comment cannot be empty' });
    return;
  }
  if (body.length > MAX_BODY) {
    res.status(400).json({ error: `Comment must be under ${MAX_BODY} characters` });
    return;
  }
  const anchorText = String(b.anchorText ?? '').slice(0, MAX_ANCHOR);
  const id = newId();
  const now = nowIso();

  // INSERT…SELECT over an owner-filtered note: if the note is not this user's, no
  // row is written rather than a row being grafted onto someone else's note.
  const row = await db
    .prepare(
      `INSERT INTO note_comments (id, note_id, anchor_text, body, resolved, created_at, updated_at)
       SELECT ?, id, ?, ?, 0, ?, ? FROM notes WHERE id = ? AND user_id = ? AND deleted_at IS NULL
       RETURNING *`,
    )
    .get<CommentRow>(id, anchorText, body, now, now, req.params.noteId, uid);

  if (!row) {
    res.status(404).json({ error: 'Note not found' });
    return;
  }
  res.status(201).json({ comment: serialize(row) });
});

/** PATCH /api/comments/:id — edit the body and/or resolve. */
router.patch('/comments/:id', async (req, res) => {
  const uid = userId(req);
  const b = (req.body ?? {}) as Record<string, unknown>;

  const body = typeof b.body === 'string' ? b.body.trim() : null;
  if (body !== null && !body) {
    res.status(400).json({ error: 'Comment cannot be empty' });
    return;
  }
  if (body !== null && body.length > MAX_BODY) {
    res.status(400).json({ error: `Comment must be under ${MAX_BODY} characters` });
    return;
  }
  const resolved = typeof b.resolved === 'boolean' ? (b.resolved ? 1 : 0) : null;

  const row = await db
    .prepare(
      `UPDATE note_comments c
          SET body = COALESCE(?, c.body),
              resolved = COALESCE(?, c.resolved),
              updated_at = ?
         FROM notes n
        WHERE c.id = ? AND n.id = c.note_id AND n.user_id = ?
        RETURNING c.*`,
    )
    .get<CommentRow>(body, resolved, nowIso(), req.params.id, uid);

  if (!row) {
    res.status(404).json({ error: 'Comment not found' });
    return;
  }
  res.json({ comment: serialize(row) });
});

router.delete('/comments/:id', async (req, res) => {
  const uid = userId(req);
  const r = await db
    .prepare(
      `DELETE FROM note_comments c
        USING notes n
        WHERE c.id = ? AND n.id = c.note_id AND n.user_id = ?`,
    )
    .run(req.params.id, uid);
  if (r.changes === 0) {
    res.status(404).json({ error: 'Comment not found' });
    return;
  }
  res.json({ ok: true });
});

export default router;
