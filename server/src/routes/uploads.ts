// Serve attachment payloads out of Postgres at the URL shape note content already uses.
//
// Notes written before attachments moved into the database contain `/uploads/<stored_name>`
// in their body, and the editor still mints that shape for new images. Changing it would
// have meant rewriting every stored document, so the URL stays and the storage behind it
// changed instead.
import { Router } from 'express';
import { findAttachmentByStoredName } from '../lib/attachments.js';
import { COOKIE_NAME, readCookie, resolveSession } from '../auth/session.js';
import { shareGrantsAttachmentAccess } from './share.js';

const router = Router();

/** A year, immutable: stored_name is unique per upload, so the bytes at a given URL never change. */
const CACHE_CONTROL = 'private, max-age=31536000, immutable';

/**
 * Reject anything that is not a bare filename before it reaches the database.
 * The value is only ever used as a lookup key, never as a path, so this is belt-and-braces
 * rather than the traversal defence - but it also keeps junk out of the query.
 */
function isPlainName(name: string): boolean {
  return Boolean(name) && name.length <= 128 && !name.includes('/') && !name.includes('\\') && !name.includes('\0');
}

router.get('/:storedName', async (req, res, next) => {
  try {
    const storedName = String(req.params.storedName);
    // 404 rather than 400: an unreadable name and an absent file are the same
    // non-answer, and there is nothing to gain from distinguishing them.
    if (!isPlainName(storedName)) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    const row = await findAttachmentByStoredName(storedName);
    if (!row || !row.bytes) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    // Ownership. The owner's own session is the common case; a guest holding a share
    // link to a note that embeds this image is the deliberate exception. Everyone else
    // gets the same 404 an absent attachment would produce, so this never confirms that
    // a given attachment exists to someone not entitled to it.
    const accountId = await resolveSession(readCookie(req, COOKIE_NAME));
    let allowed = accountId != null && accountId === row.user_id;
    if (!allowed) allowed = await shareGrantsAttachmentAccess(req, storedName);
    if (!allowed) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    const bytes = Buffer.isBuffer(row.bytes) ? row.bytes : Buffer.from(row.bytes);
    // Strong ETag over the immutable identity of the row rather than a digest of the
    // payload: stored_name never refers to different bytes, so hashing megabytes on
    // every hit would buy nothing.
    const etag = `"${row.id}-${bytes.byteLength}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', CACHE_CONTROL);
    res.setHeader('Content-Type', row.mime || 'application/octet-stream');
    // Attachments are user-supplied files served from the app's own origin. Without this
    // a stored .html or .svg would run as script in that origin; `attachment`-style
    // sniffing protection plus an inline disposition keeps images displayable but inert.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');

    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }

    res.setHeader('Content-Length', String(bytes.byteLength));
    res.end(bytes);
  } catch (err) {
    next(err);
  }
});

export default router;
