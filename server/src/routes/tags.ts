import { Router } from 'express';
import { db } from '../db.js';

const router = Router();

router.get('/', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT nt.tag as tag, COUNT(*) as count
       FROM note_tags nt
       JOIN notes n ON n.id = nt.note_id
       WHERE n.archived = 0 AND n.deleted_at IS NULL
       GROUP BY nt.tag
       ORDER BY count DESC, nt.tag ASC`,
    )
    .all() as Array<{ tag: string; count: number }>;

  res.json({ tags: rows });
});

export default router;
