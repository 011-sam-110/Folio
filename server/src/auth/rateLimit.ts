import type { NextFunction, Request, Response } from 'express';
import { clientIp } from '../lib/clientIp.js';

/**
 * Throttle the unauthenticated endpoints that run scrypt.
 *
 * Login, recovery redemption and share-join each burn ~250ms of CPU and ~134MB at
 * N=2^17, deliberately even for unknown accounts (so response timing cannot reveal
 * whether an email is registered). That makes them a cheap amplifier: a security
 * review measured a legitimate login going from 284ms to 4456ms — 15.7x — under a
 * 64-request flood, with a ceiling around 11 logins/sec. The event loop stayed
 * responsive because scrypt runs on the libuv threadpool, so this starves auth
 * rather than downing the app; on serverless it converts into a billing problem
 * instead.
 *
 * Deliberately in-memory. A shared counter would mean a database round trip on the
 * hot path of every login, and on serverless each instance is short-lived anyway —
 * so this bounds what any ONE instance will do, and is honest about not being a
 * global limit. Anything stronger belongs at the edge (a WAF or platform rule),
 * not in application code.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

// Bound the map so a flood of spoofed IPs cannot itself become the memory leak.
const MAX_TRACKED = 10_000;

function sweep(now: number): void {
  for (const [key, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(key);
  }
  if (buckets.size > MAX_TRACKED) {
    // Still oversized after expiry: drop the oldest-expiring entries. Losing state
    // for some clients is strictly better than growing without bound.
    const byExpiry = [...buckets.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
    for (const [key] of byExpiry.slice(0, buckets.size - MAX_TRACKED)) buckets.delete(key);
  }
}

/**
 * Identify the caller.
 *
 * This previously read `x-forwarded-for` and took the FIRST entry, which is the value the
 * original client supplied and is therefore chosen by the attacker. Varying that header
 * per request put every attempt in a fresh bucket, so the limits below never fired: the
 * login and recovery throttles could be walked straight past, and with them the scrypt
 * CPU amplification this module exists to prevent. The comment here also claimed
 * `trust proxy` was configured in app.ts when it was not; it is now.
 *
 * Resolution moved to lib/clientIp.ts, which prefers the platform-set header on Vercel and
 * otherwise uses the socket-derived `req.ip`. Never the client-supplied first hop.
 */
function clientKey(req: Request): string {
  return clientIp(req);
}

export interface RateLimitOptions {
  /** Requests allowed per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Message returned once the limit is hit. */
  message?: string;
  /** Force the limiter on under test, where it is otherwise disabled. */
  enabled?: boolean;
}

/**
 * Disabled under test. The suites sign in dozens of times from one address, so a
 * limit tuned for humans would make them fail for reasons unrelated to what they
 * assert. The limiter's own behaviour is covered directly in rateLimit.test.ts
 * rather than incidentally through every other suite.
 */
const DISABLED = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';

export function rateLimit({ limit, windowMs, message, enabled }: RateLimitOptions) {
  const off = enabled === undefined ? DISABLED : !enabled;
  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (off) {
      next();
      return;
    }
    const now = Date.now();
    if (buckets.size > 64) sweep(now);

    const key = `${req.path}:${clientKey(req)}`;
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    bucket.count += 1;
    if (bucket.count > limit) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({
        error: message ?? 'Too many attempts. Please wait a moment and try again.',
      });
      return;
    }

    next();
  };
}

/** Reset all counters. Test-only — otherwise suites leak limits into each other. */
export function _resetRateLimits(): void {
  buckets.clear();
}
