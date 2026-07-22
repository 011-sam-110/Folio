import type { NextFunction, Request, Response } from 'express';
import { COOKIE_NAME, readCookie, resolveSessionRecord, type SessionScope } from './session.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by `requireAuth`. Present on every authenticated request. */
      userId?: string;
      /** Set by `requireAuth`/`optionalAuth`. 'capture' is a paired phone, not a sign-in. */
      sessionScope?: SessionScope;
    }
  }
}

/**
 * Everything a capture-scoped session (a phone paired by QR) may reach.
 *
 * Deny by default, and enumerated in ONE place so the grant can be read in full without
 * auditing every router. Each entry is the minimum /capture actually calls:
 *
 *   GET  /api/notebooks          the chips it has to choose a destination from
 *   POST /api/import             the upload itself
 *   GET  /api/import/jobs/:id    polling that one upload (already owner-scoped in the route)
 *
 * Note what is NOT here, and is therefore refused: reading a note's content, listing or
 * searching notes, editing anything, changing the password, managing AI keys, creating
 * share links. A code scanned off someone's screen can add material to their notebooks; it
 * cannot read what is already in them, and it cannot take the account.
 *
 * /api/auth/me and /api/auth/logout are absent deliberately - they do not run through this
 * guard (the auth router resolves the session itself), and the phone needs both.
 */
const CAPTURE_ALLOWLIST: ReadonlyArray<{ method: string; pattern: RegExp }> = [
  { method: 'GET', pattern: /^\/api\/notebooks\/?$/ },
  { method: 'POST', pattern: /^\/api\/import\/?$/ },
  { method: 'GET', pattern: /^\/api\/import\/jobs\/[^/]+\/?$/ },
];

/** Path only - the query string is never part of the authorisation decision. */
function requestPath(req: Request): string {
  const q = req.originalUrl.indexOf('?');
  return q === -1 ? req.originalUrl : req.originalUrl.slice(0, q);
}

export function isCaptureAllowed(method: string, path: string): boolean {
  return CAPTURE_ALLOWLIST.some((rule) => rule.method === method.toUpperCase() && rule.pattern.test(path));
}

/**
 * Reject unauthenticated requests and pin `req.userId` for the handlers below.
 *
 * Every user-owned query scopes on this value. Handlers must never take an owner
 * id from the request body or params - that would let any signed-in user read
 * another's notes by guessing an id.
 *
 * A session also carries a scope. `req.userId` alone can no longer be read as "this
 * account authorised this request", because a QR-paired phone resolves to the same user
 * with far less authority - so the scope check happens here, rather than being left to
 * each router to remember.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const session = await resolveSessionRecord(readCookie(req, COOKIE_NAME));
    if (!session) {
      res.status(401).json({ error: 'Not signed in' });
      return;
    }
    if (session.scope !== 'full' && !isCaptureAllowed(req.method, requestPath(req))) {
      // 403, not 401: the credential is valid, it simply does not reach here. A 401 would
      // trip the SPA's session-expired handler and bounce the phone to /login mid-capture.
      res.status(403).json({
        error: 'This phone is paired for capture only. Sign in on this device for full access.',
      });
      return;
    }
    req.userId = session.userId;
    req.sessionScope = session.scope;
    next();
  } catch (err) {
    next(err);
  }
}

/** Populate `req.userId` when a session exists, but allow anonymous through. */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const session = await resolveSessionRecord(readCookie(req, COOKIE_NAME));
    req.userId = session?.userId;
    req.sessionScope = session?.scope;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Narrow `req.userId` to a string for handlers mounted behind `requireAuth`.
 * Throws rather than returning a sentinel, so a route accidentally mounted
 * without the guard fails loudly instead of silently querying `undefined`.
 */
export function userId(req: Request): string {
  if (!req.userId) throw new Error('route requires requireAuth middleware');
  return req.userId;
}
