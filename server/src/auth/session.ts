import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { db, nowIso } from '../db.js';
import { SESSION_SECRET, IS_SERVERLESS } from '../config.js';

export const COOKIE_NAME = 'folio_session';
const SESSION_DAYS = 30;

/**
 * What a session is allowed to reach.
 *
 * 'full'    - a normal sign-in. Everything the account can do.
 * 'capture' - a phone that redeemed a QR pairing code. Same user, but admitted only to
 *             the routes listed in auth/middleware.ts. It is NOT a sign-in and must never
 *             be treated as one.
 *
 * The column defaults to 'full', so every session issued before this existed keeps
 * exactly the authority it had.
 */
export type SessionScope = 'full' | 'capture';

export interface SessionRecord {
  userId: string;
  scope: SessionScope;
}

/** Anything unrecognised in the column is treated as the least authority, not the most. */
function toScope(raw: unknown): SessionScope {
  return raw === 'capture' ? 'capture' : raw === 'full' ? 'full' : 'capture';
}

/**
 * Sessions are opaque random tokens; only their HMAC is stored.
 *
 * Hashing (rather than storing the token) means a database leak does not hand an
 * attacker usable sessions, and using an HMAC rather than a bare digest means
 * they would additionally need SESSION_SECRET to forge a row.
 */
function tokenId(token: string): string {
  return createHmac('sha256', SESSION_SECRET).update(token).digest('hex');
}

export async function createSession(
  userId: string,
  opts: { scope?: SessionScope; ttlMs?: number } = {},
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const ttlMs = opts.ttlMs ?? SESSION_DAYS * 864e5;
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  await db
    .prepare('INSERT INTO sessions (id, user_id, expires_at, scope, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(tokenId(token), userId, expiresAt, opts.scope ?? 'full', nowIso());
  return token;
}

/** Resolve a session to its user AND its scope. Prefer this over `resolveSession`. */
export async function resolveSessionRecord(token: string | undefined): Promise<SessionRecord | null> {
  if (!token) return null;
  const row = await db
    .prepare('SELECT user_id, expires_at, scope FROM sessions WHERE id = ?')
    .get<{ user_id: string; expires_at: string; scope: string }>(tokenId(token));
  if (!row) return null;
  if (row.expires_at <= nowIso()) {
    await db.prepare('DELETE FROM sessions WHERE id = ?').run(tokenId(token));
    return null;
  }
  return { userId: row.user_id, scope: toScope(row.scope) };
}

/**
 * Resolve a session to its user id, ignoring scope.
 *
 * Kept for callers that only ask "is anyone signed in" and do not gate authority on the
 * answer (share.ts recognising a note's owner, /me). Anything that grants access to
 * user-owned data must use `resolveSessionRecord` and honour the scope - see requireAuth.
 */
export async function resolveSession(token: string | undefined): Promise<string | null> {
  return (await resolveSessionRecord(token))?.userId ?? null;
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (!token) return;
  await db.prepare('DELETE FROM sessions WHERE id = ?').run(tokenId(token));
}

/** Remove expired rows. Cheap, and called opportunistically on login. */
export async function pruneExpiredSessions(): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso());
}

/** Read a cookie without pulling in cookie-parser. */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

export function setSessionCookie(res: Response, token: string, maxAgeMs?: number): void {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true, // unreachable from JS, so XSS cannot exfiltrate the session
    // 'lax' is load-bearing for phone capture, not just CSRF hygiene: the phone arrives at
    // /capture as a top-level navigation from the camera app, which some Android launchers
    // present as cross-site. 'lax' sends the cookie on a top-level GET; 'strict' would not,
    // and the freshly paired phone would appear signed out on its very first page load.
    sameSite: 'lax', // blocks cross-site CSRF while keeping normal top-level navigation
    secure: IS_SERVERLESS, // HTTPS-only in production; plain http works for local dev
    path: '/',
    // Mirrors the row's expires_at. The row is what is actually enforced; this only stops
    // the browser sending a cookie that is already dead.
    maxAge: maxAgeMs ?? SESSION_DAYS * 864e5,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

/** Constant-time string compare for non-secret-length-sensitive comparisons. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
