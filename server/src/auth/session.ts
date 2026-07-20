import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { db, nowIso } from '../db.js';
import { SESSION_SECRET, IS_SERVERLESS } from '../config.js';

export const COOKIE_NAME = 'folio_session';
const SESSION_DAYS = 30;

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

export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  await db
    .prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(tokenId(token), userId, expiresAt, nowIso());
  return token;
}

export async function resolveSession(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  const row = await db
    .prepare('SELECT user_id, expires_at FROM sessions WHERE id = ?')
    .get<{ user_id: string; expires_at: string }>(tokenId(token));
  if (!row) return null;
  if (row.expires_at <= nowIso()) {
    await db.prepare('DELETE FROM sessions WHERE id = ?').run(tokenId(token));
    return null;
  }
  return row.user_id;
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

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true, // unreachable from JS, so XSS cannot exfiltrate the session
    sameSite: 'lax', // blocks cross-site CSRF while keeping normal top-level navigation
    secure: IS_SERVERLESS, // HTTPS-only in production; plain http works for local dev
    path: '/',
    maxAge: SESSION_DAYS * 864e5,
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
