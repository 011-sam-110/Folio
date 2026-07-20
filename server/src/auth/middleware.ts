import type { NextFunction, Request, Response } from 'express';
import { COOKIE_NAME, readCookie, resolveSession } from './session.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by `requireAuth`. Present on every authenticated request. */
      userId?: string;
    }
  }
}

/**
 * Reject unauthenticated requests and pin `req.userId` for the handlers below.
 *
 * Every user-owned query scopes on this value. Handlers must never take an owner
 * id from the request body or params — that would let any signed-in user read
 * another's notes by guessing an id.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = await resolveSession(readCookie(req, COOKIE_NAME));
    if (!userId) {
      res.status(401).json({ error: 'Not signed in' });
      return;
    }
    req.userId = userId;
    next();
  } catch (err) {
    next(err);
  }
}

/** Populate `req.userId` when a session exists, but allow anonymous through. */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    req.userId = (await resolveSession(readCookie(req, COOKIE_NAME))) ?? undefined;
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
