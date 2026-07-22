// Resolve an OAuth sign-in to a Unote account.
//
// The provider callback hands us an identity (a provider + a stable id, plus an email
// the provider may or may not have verified). This decides which local user that maps
// to, in a fixed precedence order, and it is the ONE place the link-by-verified-email
// policy lives.
//
// Kept free of any database, Express or provider detail so the whole policy can be
// unit-tested against a fake store (see test/oauth.test.ts). The db-backed store lives
// in routes/oauth.ts.

export interface OAuthProfile {
  provider: string;
  providerUserId: string;
  /** The address the provider reports. Lower-cased here defensively. */
  email: string | null;
  /** True only when the provider vouches the address belongs to this user. */
  emailVerified: boolean;
  displayName: string;
}

export type OAuthOutcome = 'existing-identity' | 'linked' | 'created';

export interface ResolveResult {
  userId: string;
  outcome: OAuthOutcome;
}

/**
 * A refusal the callback turns into a friendly redirect. `code` is a stable token the
 * login page maps to human copy; the message is for logs only and is never shown raw.
 */
export class OAuthResolveError extends Error {
  code: 'email_unverified' | 'no_email';
  constructor(code: 'email_unverified' | 'no_email', message: string) {
    super(message);
    this.code = code;
    this.name = 'OAuthResolveError';
  }
}

/**
 * The only persistence the policy needs. Deliberately narrow - two lookups and two
 * writes - so the fake in the test is trivial and the real store has nowhere to hide
 * behaviour the tests do not see.
 *
 * `createUser` is expected to provision a complete, passwordless account (row + the
 * first identity, and the same starter-notebook seeding a password signup does).
 */
export interface OAuthUserStore {
  findIdentity(provider: string, providerUserId: string): Promise<{ userId: string } | null>;
  findUserByEmail(email: string): Promise<{ id: string } | null>;
  linkIdentity(args: {
    provider: string;
    providerUserId: string;
    userId: string;
    email: string;
  }): Promise<void>;
  createUser(args: {
    email: string;
    displayName: string;
    provider: string;
    providerUserId: string;
  }): Promise<{ id: string }>;
}

function normaliseEmail(email: string | null): string | null {
  const e = (email ?? '').trim().toLowerCase();
  return e || null;
}

/**
 * Map an OAuth identity to a local user.
 *
 *   1. Known identity   -> that user (already bound; trust it).
 *   2. Verified email that matches an existing account -> link into it.
 *   3. Otherwise         -> create a new passwordless account.
 *
 * The verified-email gate guards BOTH linking and creation. Linking is the obvious
 * case: adopting an identity into an existing account on the strength of an address
 * the provider has not verified would let anyone who can make a provider emit an
 * arbitrary address seize that account. Creation needs the same gate for a subtler
 * reason - the email stored on a new account becomes the link target for rule 2 on the
 * NEXT provider that reports it, so creating from an unverified address just defers the
 * same hijack. It is the same guard, not a weaker one.
 */
export async function resolveOAuthUser(
  store: OAuthUserStore,
  profile: OAuthProfile,
): Promise<ResolveResult> {
  const existing = await store.findIdentity(profile.provider, profile.providerUserId);
  if (existing) return { userId: existing.userId, outcome: 'existing-identity' };

  const email = normaliseEmail(profile.email);
  // No usable address: nothing to key an account on, and every by-email path downstream
  // assumes one. Refuse with a readable reason rather than inventing a placeholder.
  if (!email) {
    throw new OAuthResolveError('no_email', `${profile.provider} returned no email address`);
  }

  const byEmail = await store.findUserByEmail(email);
  if (byEmail) {
    if (!profile.emailVerified) {
      throw new OAuthResolveError(
        'email_unverified',
        `${profile.provider} email is not verified; refusing to link to an existing account`,
      );
    }
    await store.linkIdentity({
      provider: profile.provider,
      providerUserId: profile.providerUserId,
      userId: byEmail.id,
      email,
    });
    return { userId: byEmail.id, outcome: 'linked' };
  }

  if (!profile.emailVerified) {
    throw new OAuthResolveError(
      'email_unverified',
      `${profile.provider} email is not verified; refusing to create an account from it`,
    );
  }
  const created = await store.createUser({
    email,
    displayName: profile.displayName,
    provider: profile.provider,
    providerUserId: profile.providerUserId,
  });
  return { userId: created.id, outcome: 'created' };
}
