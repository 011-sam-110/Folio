import type { Request } from 'express';
import { IS_SERVERLESS } from '../config.js';

/**
 * The caller's IP address, resolved so a client cannot choose its own value.
 *
 * This matters because two separate defences key on it: the scrypt throttle on the auth
 * routes, and the monthly AI quota. Both are worthless if the identity they count against
 * is attacker-supplied.
 *
 * `X-Forwarded-For` is a chain, appended to by each proxy it passes through, so the
 * LEFTMOST entry is whatever the original client sent — forgeable, and therefore useless
 * as an identity. Reading `[0]` gives an attacker a fresh bucket per request simply by
 * varying a header. The trustworthy entry is the RIGHTMOST one, appended by the proxy
 * immediately in front of us, and it is only trustworthy at all when we know a proxy is
 * actually there.
 *
 * On Vercel, `x-vercel-forwarded-for` is set by the platform edge, which overwrites any
 * client-supplied copy, so it is preferred when present. Off Vercel we rely on Express's
 * `trust proxy` setting (configured in app.ts) having already resolved `req.ip` correctly,
 * and fall back to the raw socket address, which cannot be spoofed by a header at all.
 */
export function clientIp(req: Request): string {
  if (IS_SERVERLESS) {
    const vercel = req.headers['x-vercel-forwarded-for'];
    const value = Array.isArray(vercel) ? vercel[0] : vercel;
    // Even this is a chain in principle; take the last hop, never the first.
    const hop = value?.split(',').pop()?.trim();
    if (hop) return hop;
  }

  // `req.ip` already accounts for `trust proxy`. Behind a correctly configured proxy it
  // is the last untrusted hop; with no proxy configured it is the socket address. Either
  // way it is not simply "whatever the client put in a header".
  const ip = req.ip ?? req.socket.remoteAddress;
  return (ip ?? 'unknown').trim();
}
