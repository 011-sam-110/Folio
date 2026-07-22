/**
 * One-shot pairing codes for phone capture.
 *
 * The problem this solves: /capture is a page for a device that has never signed in.
 * Before this existed, the route sat behind the normal session guard, so scanning the QR
 * on a phone landed on /login - the flow could not work at all, however correct the URL
 * in the QR was.
 *
 * The shape is deliberately the same as note_shares (routes/share.ts): a random bearer
 * token, stored only as an HMAC, exchanged for a scoped credential. Three properties
 * matter, and each is enforced here rather than by the caller:
 *
 *   short-lived  - PAIRING_TTL_MS is the time between looking at a screen and raising a
 *                  phone, not a session length. A QR left on a projector goes stale.
 *   single-use   - redemption is one conditional UPDATE, so two devices racing the same
 *                  code cannot both win, and a photograph of the QR is worthless once the
 *                  intended phone has used it.
 *   narrow       - it yields a session with scope 'capture', not a sign-in. What that
 *                  scope may reach is enumerated in auth/middleware.ts.
 *
 * The token is NOT a signed self-describing blob (unlike the OAuth flow state). Signed
 * tokens cannot be revoked or spent without a server-side record anyway, and once a row
 * is required the row may as well be the token.
 */

import { createHmac, randomBytes } from 'node:crypto';
import { db, newId, nowIso } from '../db.js';
import { SESSION_SECRET } from '../config.js';

/** How long a freshly displayed QR stays scannable. */
export const PAIRING_TTL_MS = 5 * 60_000;

/**
 * How long the phone stays paired after redeeming a code.
 *
 * A study session, not a login. The desktop session lasts 30 days; a device that was
 * authorised by pointing a camera at a screen should not, and this bounds the damage from
 * a phone that is lost, borrowed or left on a library desk.
 */
export const CAPTURE_SESSION_TTL_MS = 12 * 3600_000;

/**
 * Domain-separated so a pairing token can never be confused with any other value HMACed
 * under SESSION_SECRET (session ids, share tokens, OAuth state all share the key).
 */
function hashToken(token: string): string {
  return createHmac('sha256', SESSION_SECRET).update(`capture-pairing.v1:${token}`).digest('hex');
}

export interface Pairing {
  token: string;
  expiresAt: string;
}

/** Mint a code for `userId`. The raw token is returned once and is not recoverable. */
export async function createPairing(userId: string): Promise<Pairing> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString();
  await db
    .prepare(
      `INSERT INTO capture_pairings (id, user_id, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(newId(), userId, hashToken(token), expiresAt, nowIso());
  return { token, expiresAt };
}

/**
 * Spend a code. Returns the user it was minted for, or null for anything unusable -
 * unknown, expired, or already redeemed. The caller must not distinguish between those
 * cases to the client.
 *
 * The guard is inside the UPDATE, not a read-then-write: on serverless two polls of the
 * same code can land on different instances at the same moment, and a check followed by a
 * separate write would let both through.
 */
export async function redeemPairing(token: string): Promise<string | null> {
  if (!token) return null;
  const now = nowIso();
  const row = await db
    .prepare(
      `UPDATE capture_pairings
          SET consumed_at = ?
        WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
        RETURNING user_id`,
    )
    .get<{ user_id: string }>(now, hashToken(token), now);
  return row?.user_id ?? null;
}

/**
 * Drop codes that can no longer be redeemed. Called opportunistically when minting, so
 * the table cannot grow without bound on a deployment with no scheduled jobs. Spent rows
 * are kept until they would have expired anyway - that is what makes a replay of a
 * photographed QR fail as "already used" rather than "unknown".
 */
export async function pruneExpiredPairings(): Promise<number> {
  const r = await db.prepare('DELETE FROM capture_pairings WHERE expires_at <= ?').run(nowIso());
  return r.changes;
}
