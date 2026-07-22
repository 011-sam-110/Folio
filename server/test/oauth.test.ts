// OAuth sign-in policy + plumbing.
//
// The link/create resolution is tested against an in-memory fake store, so all three
// branches and the verified-email guard run with no Postgres and no network. The
// provider gate and the signed-state integrity are exercised directly. A full live
// round trip (real Google/GitHub) cannot be automated here without real credentials and
// a browser at the provider — that part is verified by hand once creds exist; everything
// AROUND it is covered below.

import { describe, it, expect, afterEach } from 'vitest';
import {
  resolveOAuthUser,
  OAuthResolveError,
  type OAuthProfile,
  type OAuthUserStore,
} from '../src/auth/oauthResolve.js';
import { config } from '../src/config.js';
import { enabledProviders, isProviderEnabled } from '../src/auth/oauthProviders.js';
import {
  encodeState,
  decodeState,
  newFlowState,
  pkceChallenge,
  statesMatch,
  type OAuthFlowState,
} from '../src/auth/oauthState.js';

// --- fake store ---------------------------------------------------------------------

class FakeStore implements OAuthUserStore {
  identities = new Map<string, string>(); // `${provider}:${pid}` -> userId
  usersByEmail = new Map<string, string>(); // lower(email) -> userId
  created: Array<{ id: string; email: string; displayName: string }> = [];
  linked: Array<{ provider: string; providerUserId: string; userId: string; email: string }> = [];

  seedUser(email: string, userId: string) {
    this.usersByEmail.set(email.toLowerCase(), userId);
  }
  seedIdentity(provider: string, pid: string, userId: string) {
    this.identities.set(`${provider}:${pid}`, userId);
  }

  async findIdentity(provider: string, pid: string) {
    const u = this.identities.get(`${provider}:${pid}`);
    return u ? { userId: u } : null;
  }
  async findUserByEmail(email: string) {
    const u = this.usersByEmail.get(email.toLowerCase());
    return u ? { id: u } : null;
  }
  async linkIdentity(a: { provider: string; providerUserId: string; userId: string; email: string }) {
    this.identities.set(`${a.provider}:${a.providerUserId}`, a.userId);
    this.linked.push(a);
  }
  async createUser(a: { email: string; displayName: string; provider: string; providerUserId: string }) {
    const id = `new-${this.created.length + 1}`;
    this.created.push({ id, email: a.email, displayName: a.displayName });
    this.usersByEmail.set(a.email.toLowerCase(), id);
    this.identities.set(`${a.provider}:${a.providerUserId}`, id);
    return { id };
  }
}

function profile(over: Partial<OAuthProfile> = {}): OAuthProfile {
  return {
    provider: 'google',
    providerUserId: 'g-123',
    email: 'sam@example.com',
    emailVerified: true,
    displayName: 'Sam',
    ...over,
  };
}

// --- resolution: the three branches -------------------------------------------------

describe('resolveOAuthUser', () => {
  it('branch 1: an existing identity returns its user without linking or creating', async () => {
    const store = new FakeStore();
    store.seedIdentity('google', 'g-123', 'user-a');

    const res = await resolveOAuthUser(store, profile());

    expect(res).toEqual({ userId: 'user-a', outcome: 'existing-identity' });
    expect(store.linked).toHaveLength(0);
    expect(store.created).toHaveLength(0);
  });

  it('branch 2: a verified email matching an existing account links into it', async () => {
    const store = new FakeStore();
    store.seedUser('sam@example.com', 'user-b');

    const res = await resolveOAuthUser(store, profile({ emailVerified: true }));

    expect(res).toEqual({ userId: 'user-b', outcome: 'linked' });
    expect(store.linked).toEqual([
      { provider: 'google', providerUserId: 'g-123', userId: 'user-b', email: 'sam@example.com' },
    ]);
    expect(store.created).toHaveLength(0);
  });

  it('branch 2 is case-insensitive on the email', async () => {
    const store = new FakeStore();
    store.seedUser('sam@example.com', 'user-b');

    const res = await resolveOAuthUser(store, profile({ email: 'SAM@Example.com' }));

    expect(res.outcome).toBe('linked');
    expect(res.userId).toBe('user-b');
  });

  it('branch 3: a verified email with no match creates a passwordless account', async () => {
    const store = new FakeStore();

    const res = await resolveOAuthUser(store, profile({ email: 'new@example.com' }));

    expect(res.outcome).toBe('created');
    expect(res.userId).toBe('new-1');
    expect(store.created).toHaveLength(1);
    expect(store.created[0].email).toBe('new@example.com');
  });

  // --- the verified-email guard -----------------------------------------------------

  it('refuses to LINK an unverified email to an existing account', async () => {
    const store = new FakeStore();
    store.seedUser('sam@example.com', 'user-b');

    await expect(resolveOAuthUser(store, profile({ emailVerified: false }))).rejects.toMatchObject({
      code: 'email_unverified',
    });
    // Critically: no identity was attached to the victim account.
    expect(store.linked).toHaveLength(0);
    expect(await store.findIdentity('google', 'g-123')).toBeNull();
  });

  it('refuses to CREATE an account from an unverified email (future-hijack guard)', async () => {
    const store = new FakeStore();

    await expect(
      resolveOAuthUser(store, profile({ email: 'nobody@example.com', emailVerified: false })),
    ).rejects.toBeInstanceOf(OAuthResolveError);
    expect(store.created).toHaveLength(0);
  });

  it('refuses when the provider returns no email at all', async () => {
    const store = new FakeStore();

    await expect(resolveOAuthUser(store, profile({ email: null }))).rejects.toMatchObject({
      code: 'no_email',
    });
    expect(store.created).toHaveLength(0);
    expect(store.linked).toHaveLength(0);
  });

  it('an already-linked identity wins even when the email is now unverified', async () => {
    // Once bound, an identity is trusted regardless of the current email signal — the
    // verified gate only guards the first link/create, not subsequent logins.
    const store = new FakeStore();
    store.seedIdentity('github', 'gh-9', 'user-c');

    const res = await resolveOAuthUser(
      store,
      profile({ provider: 'github', providerUserId: 'gh-9', emailVerified: false }),
    );

    expect(res).toEqual({ userId: 'user-c', outcome: 'existing-identity' });
  });
});

// --- provider feature-flag gate -----------------------------------------------------

describe('provider gate', () => {
  afterEach(() => {
    // Restore whatever the loaded .env produced.
    config.oauth.google.clientId = process.env.GOOGLE_CLIENT_ID ?? '';
    config.oauth.google.clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? '';
    config.oauth.github.clientId = process.env.GITHUB_CLIENT_ID ?? '';
    config.oauth.github.clientSecret = process.env.GITHUB_CLIENT_SECRET ?? '';
  });

  it('hides a provider unless BOTH its id and secret are present', () => {
    config.oauth.google.clientId = '';
    config.oauth.google.clientSecret = '';
    expect(isProviderEnabled('google')).toBe(false);
    expect(enabledProviders().find((p) => p.id === 'google')).toBeUndefined();

    config.oauth.google.clientId = 'only-an-id';
    config.oauth.google.clientSecret = '';
    expect(isProviderEnabled('google')).toBe(false); // needs both
  });

  it('enables a provider once id and secret are both set', () => {
    config.oauth.github.clientId = 'gh-id';
    config.oauth.github.clientSecret = 'gh-secret';
    expect(isProviderEnabled('github')).toBe(true);
    expect(enabledProviders().map((p) => p.id)).toContain('github');
  });

  it('is empty when nothing is configured (the production-with-no-creds case)', () => {
    config.oauth.google.clientId = '';
    config.oauth.google.clientSecret = '';
    config.oauth.github.clientId = '';
    config.oauth.github.clientSecret = '';
    expect(enabledProviders()).toEqual([]);
  });

  it('never reports an unknown provider as enabled', () => {
    expect(isProviderEnabled('facebook')).toBe(false);
  });
});

// --- signed state / PKCE integrity --------------------------------------------------

describe('signed flow state', () => {
  const flow: OAuthFlowState = {
    provider: 'google',
    state: 'abc123',
    verifier: 'verifier-xyz',
    returnTo: '/',
    exp: Date.now() + 60_000,
  };

  it('round-trips a valid cookie', () => {
    expect(decodeState(encodeState(flow))).toEqual(flow);
  });

  it('rejects a tampered payload', () => {
    const [payload, mac] = encodeState(flow).split('.');
    const tampered = `${payload}x.${mac}`;
    expect(decodeState(tampered)).toBeNull();
  });

  it('rejects a forged signature', () => {
    const payload = encodeState(flow).split('.')[0];
    expect(decodeState(`${payload}.not-the-real-mac`)).toBeNull();
  });

  it('rejects an expired flow', () => {
    expect(decodeState(encodeState({ ...flow, exp: Date.now() - 1 }))).toBeNull();
  });

  it('rejects missing or malformed cookies', () => {
    expect(decodeState(undefined)).toBeNull();
    expect(decodeState('no-dot-here')).toBeNull();
  });

  it('newFlowState issues a PKCE challenge only when the provider supports it', () => {
    const withPkce = newFlowState({ provider: 'google', usePkce: true, returnTo: '/' });
    expect(withPkce.flow.verifier).not.toBe('');
    expect(withPkce.challenge).toBe(pkceChallenge(withPkce.flow.verifier));

    const withoutPkce = newFlowState({ provider: 'github', usePkce: false, returnTo: '/' });
    expect(withoutPkce.flow.verifier).toBe('');
    expect(withoutPkce.challenge).toBeNull();
  });

  it('statesMatch is exact', () => {
    expect(statesMatch('abc', 'abc')).toBe(true);
    expect(statesMatch('abc', 'abd')).toBe(false);
    expect(statesMatch('abc', 'abcd')).toBe(false);
  });
});
