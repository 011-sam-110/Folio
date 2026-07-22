// CSRF state + PKCE for the OAuth redirect dance, carried across the round trip in a
// short-lived signed cookie.
//
// The browser leaves for the provider and comes back; between those two requests the
// server holds nothing in memory (serverless has no shared state anyway), so the
// `state` nonce and the PKCE `code_verifier` ride in a cookie that is HMAC-signed with
// SESSION_SECRET. Signing means the client cannot forge or tamper with the flow, and an
// embedded expiry bounds replay even if the cookie leaks.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { SESSION_SECRET, IS_SERVERLESS, config } from '../config.js';

export const OAUTH_COOKIE = 'folio_oauth';

// Long enough to complete a real sign-in (including first-time consent), short enough
// to bound how long a captured start is useful.
const TTL_MS = 10 * 60_000;

export interface OAuthFlowState {
  provider: string;
  state: string;
  /** PKCE verifier, or '' for providers that do not support PKCE (e.g. GitHub). */
  verifier: string;
  returnTo: string;
  /** Absolute expiry (ms epoch); checked on decode independently of the cookie maxAge. */
  exp: number;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** PKCE S256 code challenge for a verifier. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function sign(payload: string): string {
  return createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function encodeState(flow: OAuthFlowState): string {
  const payload = Buffer.from(JSON.stringify(flow), 'utf8').toString('base64url');
  return `${payload}.${sign(payload)}`;
}

/** Verify and parse a signed flow cookie; returns null for anything untrusted or expired. */
export function decodeState(raw: string | undefined): OAuthFlowState | null {
  if (!raw) return null;
  const dot = raw.indexOf('.');
  if (dot === -1) return null;
  const payload = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  if (!constantTimeEqual(mac, sign(payload))) return null;
  try {
    const flow = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as OAuthFlowState;
    if (
      typeof flow.provider !== 'string' ||
      typeof flow.state !== 'string' ||
      typeof flow.verifier !== 'string' ||
      typeof flow.returnTo !== 'string' ||
      typeof flow.exp !== 'number' ||
      flow.exp < Date.now()
    ) {
      return null;
    }
    return flow;
  } catch {
    return null;
  }
}

/** Build the flow state (and PKCE challenge, when the provider supports it) for a start. */
export function newFlowState(args: {
  provider: string;
  usePkce: boolean;
  returnTo: string;
}): { flow: OAuthFlowState; challenge: string | null } {
  const state = randomToken();
  const verifier = args.usePkce ? randomToken(32) : '';
  const flow: OAuthFlowState = {
    provider: args.provider,
    state,
    verifier,
    returnTo: args.returnTo,
    exp: Date.now() + TTL_MS,
  };
  return { flow, challenge: verifier ? pkceChallenge(verifier) : null };
}

export function setStateCookie(res: Response, flow: OAuthFlowState): void {
  res.cookie(OAUTH_COOKIE, encodeState(flow), {
    httpOnly: true,
    // 'lax' is required, not just preferred: the callback arrives as a top-level
    // navigation from the provider's origin, and a 'strict' cookie would not be sent on
    // that cross-site redirect — the flow would fail every time. 'lax' still blocks the
    // CSRF this cookie exists to stop.
    sameSite: 'lax',
    secure: IS_SERVERLESS,
    path: '/',
    maxAge: TTL_MS,
  });
}

export function clearStateCookie(res: Response): void {
  res.clearCookie(OAUTH_COOKIE, { path: '/' });
}

/** Constant-time compare of the returned `state` against the one we issued. */
export function statesMatch(a: string, b: string): boolean {
  return constantTimeEqual(a, b);
}

/**
 * The public origin this deployment is reached at, used to build the OAuth redirect_uri.
 *
 * That URI must match what is registered with the provider EXACTLY, so it is resolved
 * from a fixed source rather than guessed:
 *   1. OAUTH_BASE_URL  — explicit; set this for local dev and any custom domain.
 *   2. Vercel's production hostname — stable on the main deployment.
 *   3. the request's own proto+host — last resort, correct for a plain local run.
 */
export function appBaseUrl(req: Request): string {
  if (config.oauth.baseUrl) return config.oauth.baseUrl.replace(/\/$/, '');
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (prod) return `https://${prod}`;
  return `${req.protocol}://${req.get('host')}`;
}

export function callbackUrl(req: Request, provider: string): string {
  return `${appBaseUrl(req)}/api/auth/oauth/${provider}/callback`;
}
