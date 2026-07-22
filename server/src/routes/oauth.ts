// OAuth (social) sign-in: Google + GitHub now, provider-agnostic so Apple slots in with
// one registry entry (see auth/oauthProviders.ts) and two env vars (see config.ts).
//
// Three routes, all UNAUTHENTICATED by necessity - they are how a session is obtained:
//   GET /api/auth/providers                    which providers are configured (gate)
//   GET /api/auth/oauth/:provider/start        redirect to the provider (state + PKCE)
//   GET /api/auth/oauth/:provider/callback     exchange the code, resolve, open a session
//
// The link/create policy is in auth/oauthResolve.ts; this file supplies the db-backed
// store and the HTTP plumbing, and reuses the SAME session helper the password routes do
// (createSession + setSessionCookie) so an OAuth login is indistinguishable afterwards.

import { Router } from 'express';
import type { Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { db, newId, nowIso, tx } from '../db.js';
import { createSession, setSessionCookie, readCookie } from '../auth/session.js';
import { hashPassword } from '../auth/password.js';
import { generateRecoveryKey, hashRecoveryKey } from '../auth/recovery.js';
import { rateLimit } from '../auth/rateLimit.js';
import { seedNewUser } from '../seed.js';
import { OAUTH_PROVIDERS, enabledProviders, isProviderEnabled } from '../auth/oauthProviders.js';
import {
  newFlowState,
  setStateCookie,
  clearStateCookie,
  decodeState,
  statesMatch,
  callbackUrl,
  OAUTH_COOKIE,
} from '../auth/oauthState.js';
import {
  resolveOAuthUser,
  OAuthResolveError,
  type OAuthProfile,
  type OAuthUserStore,
  type ResolveResult,
} from '../auth/oauthResolve.js';

const router = Router();

/** Bounce back to the login page with a machine-readable reason the client maps to copy. */
function loginRedirect(res: Response, params: Record<string, string>): void {
  const q = new URLSearchParams(params).toString();
  res.redirect(`/login${q ? `?${q}` : ''}`);
}

/** Only same-origin app paths may be a post-login destination, and never an auth page. */
function safeReturnTo(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return '/';
  if (raw.startsWith('/login') || raw.startsWith('/signup')) return '/';
  return raw;
}

/**
 * The db-backed store the resolution policy runs against.
 *
 * `createUser` provisions a complete, passwordless account. The users table keeps
 * password_hash / password_salt NOT NULL, so both are filled with the hash of a random
 * secret that is discarded immediately - nobody, including this account's owner, holds a
 * value that verifies against it, so the password-login and recovery routes simply never
 * match for an OAuth account. That means those security-sensitive routes need no change
 * and cannot be weakened; the only way into the account is the provider.
 */
const dbStore: OAuthUserStore = {
  async findIdentity(provider, providerUserId) {
    const row = await db
      .prepare('SELECT user_id FROM oauth_identities WHERE provider = ? AND provider_user_id = ?')
      .get<{ user_id: string }>(provider, providerUserId);
    return row ? { userId: row.user_id } : null;
  },

  async findUserByEmail(email) {
    const row = await db
      .prepare('SELECT id FROM users WHERE lower(email) = ?')
      .get<{ id: string }>(email);
    return row ? { id: row.id } : null;
  },

  async linkIdentity({ provider, providerUserId, userId, email }) {
    await db
      .prepare(
        `INSERT INTO oauth_identities (id, provider, provider_user_id, user_id, email, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (provider, provider_user_id) DO NOTHING`,
      )
      .run(newId(), provider, providerUserId, userId, email, nowIso());
  },

  async createUser({ email, displayName, provider, providerUserId }) {
    const pw = await hashPassword(randomBytes(32).toString('hex'));
    const rec = await hashRecoveryKey(generateRecoveryKey());
    const id = newId();
    // User row + first identity in one transaction, so a failure cannot leave a user with
    // no way to sign in or an orphaned identity.
    await tx(async (t) => {
      await t
        .prepare(
          `INSERT INTO users (id, email, display_name, password_hash, password_salt,
                              recovery_key_hash, recovery_key_salt, recovery_key_used, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        )
        .run(id, email, displayName || email.split('@')[0], pw.hash, pw.salt, rec.hash, rec.salt, nowIso());
      await t
        .prepare(
          `INSERT INTO oauth_identities (id, provider, provider_user_id, user_id, email, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(newId(), provider, providerUserId, id, email, nowIso());
    });
    // Same starter notebook + built-in templates a password signup gets, so an OAuth
    // account never lands on a dead-end empty app.
    await seedNewUser(id);
    return { id };
  },
};

/**
 * Resolve, retrying once on a unique-constraint race.
 *
 * Two callbacks for the same brand-new account (a double-click, or two tabs) can both
 * pass the "no identity, no user" checks and then collide on INSERT. The loser gets a
 * Postgres 23505; by then the row exists, so a single re-resolve returns the winner's user.
 */
async function resolveWithRetry(profile: OAuthProfile): Promise<ResolveResult> {
  try {
    return await resolveOAuthUser(dbStore, profile);
  } catch (err) {
    if ((err as { code?: string })?.code === '23505') {
      return await resolveOAuthUser(dbStore, profile);
    }
    throw err;
  }
}

// --- Routes -------------------------------------------------------------------------

// Which providers are live. Drives the client's feature-flag gate: with no credentials
// set, this is an empty list and the UI renders no social buttons at all.
router.get('/providers', (_req: Request, res: Response) => {
  res.json({ providers: enabledProviders() });
});

// Kick off the flow: stash state (+ PKCE) in a signed cookie and redirect to the provider.
router.get(
  '/oauth/:provider/start',
  rateLimit({ limit: 30, windowMs: 15 * 60_000 }),
  (req: Request, res: Response) => {
    const id = String(req.params.provider);
    const def = OAUTH_PROVIDERS[id];
    if (!def || !isProviderEnabled(id)) {
      loginRedirect(res, { error: 'oauth_config', provider: id });
      return;
    }

    const returnTo = safeReturnTo(req.query.returnTo);
    const { flow, challenge } = newFlowState({ provider: id, usePkce: def.usePkce, returnTo });
    setStateCookie(res, flow);

    const url = new URL(def.authUrl);
    const p = url.searchParams;
    p.set('client_id', def.creds().clientId);
    p.set('redirect_uri', callbackUrl(req, id));
    p.set('response_type', 'code');
    p.set('scope', def.scope);
    p.set('state', flow.state);
    if (challenge) {
      p.set('code_challenge', challenge);
      p.set('code_challenge_method', 'S256');
    }
    for (const [k, v] of Object.entries(def.extraAuthParams ?? {})) p.set(k, String(v));

    res.redirect(url.toString());
  },
);

// Come back from the provider: verify state, exchange the code, resolve the identity, and
// open a session. Every failure is a friendly redirect to /login with a readable reason -
// never a token, never a stack trace.
router.get('/oauth/:provider/callback', async (req: Request, res: Response) => {
  const id = String(req.params.provider);
  const def = OAUTH_PROVIDERS[id];
  const flow = decodeState(readCookie(req, OAUTH_COOKIE));
  clearStateCookie(res); // single-use, whatever happens next

  // The user declined consent at the provider.
  if (typeof req.query.error === 'string') {
    loginRedirect(res, { error: 'oauth_denied', provider: id });
    return;
  }
  if (!def || !isProviderEnabled(id)) {
    loginRedirect(res, { error: 'oauth_config', provider: id });
    return;
  }

  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const stateParam = typeof req.query.state === 'string' ? req.query.state : '';
  // CSRF: this callback must correspond to a start WE issued, in THIS browser, for the
  // SAME provider, carrying back the exact unguessable state we signed into the cookie.
  if (!flow || flow.provider !== id || !code || !stateParam || !statesMatch(stateParam, flow.state)) {
    loginRedirect(res, { error: 'oauth_failed', provider: id });
    return;
  }

  try {
    const accessToken = await def.exchangeCode({
      code,
      redirectUri: callbackUrl(req, id),
      verifier: flow.verifier,
    });
    const profile = await def.fetchProfile(accessToken);
    const result = await resolveWithRetry({
      provider: id,
      providerUserId: profile.providerUserId,
      email: profile.email,
      emailVerified: profile.emailVerified,
      displayName: profile.displayName,
    });

    const token = await createSession(result.userId);
    setSessionCookie(res, token);
    res.redirect(flow.returnTo || '/');
  } catch (err) {
    if (err instanceof OAuthResolveError) {
      loginRedirect(res, { error: `oauth_${err.code}`, provider: id });
      return;
    }
    // Log the message for the operator; the user gets a generic, safe redirect.
    console.error('[oauth]', id, err instanceof Error ? err.message : err);
    loginRedirect(res, { error: 'oauth_failed', provider: id });
  }
});

export default router;
