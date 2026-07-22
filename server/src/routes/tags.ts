import { Router } from 'express';
// Auth is mounted once, in app.ts (`app.use('/api/tags', requireAuth, ...)`), so this
// router does not add its own guard - one layer means one place to audit and one session
// lookup per request. `userId(req)` throws if that mount ever loses the guard, so the
// failure mode is a loud 500, never an unscoped query.
import { userId } from '../auth/middleware.js';
import { db, tx, type Db } from '../db.js';

const router = Router();

interface TagRow {
  tag: string;
  count: number;
}

/**
 * Canonical tag spelling - mirrors web/src/lib/tags.ts's normalizeTag.
 *
 * The rule is duplicated rather than shared because client and server are separate
 * packages, but it must not drift: tags are matched with plain equality
 * (`nt.tag = ?` in the `tag:` search operator and GET /api/notes?tag=), which is
 * case-sensitive, so a rename that let "Revision" through would create a tag that
 * half the app can no longer find.
 */
const MAX_TAG_LENGTH = 32;
function normalizeTag(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_/-]+/gu, '')
    .replace(/^[-_/]+|[-_/]+$/g, '');
  if (!cleaned) return null;
  return cleaned.slice(0, MAX_TAG_LENGTH).replace(/^[-_/]+|[-_/]+$/g, '') || null;
}

/**
 * Move every occurrence of `from` onto `to`, for this user's notes only.
 *
 * Two statements because note_tags is PRIMARY KEY (note_id, tag): a note already
 * carrying `to` would violate the PK on a blind UPDATE, so its `from` row is
 * deleted first and the rest are renamed. That is also exactly what makes a
 * rename-onto-an-existing-tag behave as a merge, which is the behaviour the UI
 * wants anyway.
 *
 * Deliberately NOT filtered by archived/deleted_at (unlike the GET below, which
 * reports the *visible* vocabulary): a rename that skipped archived notes would
 * leave the old spelling to reappear the moment one was unarchived.
 */
async function retag(t: Db, uid: string, from: string, to: string): Promise<number> {
  await t
    .prepare(
      `DELETE FROM note_tags
        WHERE tag = ?
          AND note_id IN (SELECT id FROM notes WHERE user_id = ?)
          AND note_id IN (SELECT note_id FROM note_tags WHERE tag = ?)`,
    )
    .run(from, uid, to);

  const moved = await t
    .prepare(
      `UPDATE note_tags SET tag = ?
        WHERE tag = ?
          AND note_id IN (SELECT id FROM notes WHERE user_id = ?)`,
    )
    .run(to, from, uid);

  return moved.changes;
}

router.get('/', async (req, res) => {
  const uid = userId(req);
  // note_tags has no user_id of its own, so ownership rides on the JOIN: filtering
  // n.user_id is what keeps one user's tag vocabulary (and note counts) out of
  // another's sidebar. Without it the aggregate silently spans every account.
  // COUNT(*) is BIGINT in Postgres, but db.ts registers a parser for OID 20, so
  // `count` still arrives as a JS number and the response shape is unchanged.
  const rows = await db
    .prepare(
      `SELECT nt.tag as tag, COUNT(*) as count
       FROM note_tags nt
       JOIN notes n ON n.id = nt.note_id
       WHERE n.user_id = ? AND n.archived = 0 AND n.deleted_at IS NULL
       GROUP BY nt.tag
       ORDER BY count DESC, nt.tag ASC`,
    )
    .all<TagRow>(uid);

  res.json({ tags: rows });
});

/**
 * POST /api/tags/merge - fold one or more tags into another.
 * Body: { from: string[], into: string }
 *
 * Registered before the /:tag routes so "merge" can never be read as a tag name.
 */
router.post('/merge', async (req, res) => {
  const uid = userId(req);
  const body = req.body as { from?: unknown; into?: unknown };

  const into = normalizeTag(body.into);
  if (!into) {
    res.status(400).json({ error: 'A destination tag is required' });
    return;
  }

  const rawFrom = Array.isArray(body.from) ? body.from : [body.from];
  const sources = [...new Set(rawFrom.map(normalizeTag).filter((t): t is string => !!t && t !== into))];
  if (sources.length === 0) {
    res.status(400).json({ error: 'Pick at least one different tag to merge in' });
    return;
  }

  // One transaction for the whole merge: a partial merge would leave notes split
  // across both spellings with no obvious way for the user to tell what happened.
  const updated = await tx(async (t) => {
    let total = 0;
    for (const from of sources) total += await retag(t, uid, from, into);
    return total;
  });

  res.json({ ok: true, tag: into, merged: sources, updated });
});

/**
 * PATCH /api/tags/:tag - rename a tag across every one of the user's notes.
 * Body: { tag: string }. Renaming onto an existing tag merges into it (see retag).
 */
router.patch('/:tag', async (req, res) => {
  const uid = userId(req);
  const from = normalizeTag(req.params.tag);
  const to = normalizeTag((req.body as { tag?: unknown }).tag);

  if (!from) {
    res.status(400).json({ error: 'Unknown tag' });
    return;
  }
  if (!to) {
    res.status(400).json({ error: 'A tag needs at least one letter or number' });
    return;
  }
  if (from === to) {
    res.json({ ok: true, tag: to, updated: 0 });
    return;
  }

  const updated = await tx((t) => retag(t, uid, from, to));
  if (updated === 0) {
    res.status(404).json({ error: `No notes are tagged #${from}` });
    return;
  }

  res.json({ ok: true, tag: to, updated });
});

/**
 * DELETE /api/tags/:tag - remove a tag from every one of the user's notes.
 * The notes themselves are untouched; only the note_tags rows go.
 */
router.delete('/:tag', async (req, res) => {
  const uid = userId(req);
  const tag = normalizeTag(req.params.tag);
  if (!tag) {
    res.status(400).json({ error: 'Unknown tag' });
    return;
  }

  const result = await db
    .prepare(
      `DELETE FROM note_tags
        WHERE tag = ?
          AND note_id IN (SELECT id FROM notes WHERE user_id = ?)`,
    )
    .run(tag, uid);

  if (result.changes === 0) {
    res.status(404).json({ error: `No notes are tagged #${tag}` });
    return;
  }

  res.json({ ok: true, tag, updated: result.changes });
});

export default router;
