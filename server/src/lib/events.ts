import { db, nowIso, type Db } from '../db.js';

/**
 * Append to a note's change feed, but only if somebody could actually be watching.
 *
 * Collaborators poll `note_events` for "everything since revision N" (serverless
 * functions cannot hold a WebSocket open). Two properties matter here:
 *
 *  - The owner's ordinary editor must publish too. Originally only the /share
 *    routes wrote events, so a guest on a link never saw the owner's edits — the
 *    feature looked like it worked, because two guests on the same link did sync.
 *
 *  - Autosave fires constantly, and the overwhelming majority of notes are never
 *    shared. Writing a row per keystroke-batch for all of them would grow this
 *    table without bound for no reader. The EXISTS guard lives *inside* the
 *    INSERT so the common (unshared) case costs one statement that inserts
 *    nothing, rather than a separate lookup round trip to Neon on every save.
 */
export async function recordNoteEvent(
  noteId: string,
  kind: 'doc' | 'ink' | 'item' | 'edge' | 'presence',
  payload: Record<string, unknown>,
  actor: string,
  conn: Db = db,
): Promise<void> {
  await conn
    .prepare(
      `INSERT INTO note_events (note_id, kind, payload, actor, created_at)
       SELECT ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM note_shares
           WHERE note_id = ? AND revoked = 0
             AND (expires_at IS NULL OR expires_at > ?)
        )`,
    )
    .run(noteId, kind, JSON.stringify(payload), actor, nowIso(), noteId, nowIso());
}
