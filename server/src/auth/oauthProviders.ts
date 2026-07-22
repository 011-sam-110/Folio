// Provider registry: the per-provider knobs (endpoints, scopes, PKCE support) plus the
// two network calls each one needs - exchange an authorization code for an access token,
// and turn that token into a normalised profile with a VERIFIED-email signal.
//
// Adding Apple later is a matter of one more entry here (its endpoints, usePkce: true,
// an exchange that reads the id_token, and a profile mapper) plus its two env vars in
// config.ts. Nothing outside this file and config.ts is provider-aware.

import { config } from '../config.js';

export interface OAuthProfileResult {
  providerUserId: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string;
}

interface Creds {
  clientId: string;
  clientSecret: string;
}

export interface OAuthProviderDef {
  id: string;
  label: string;
  authUrl: string;
  scope: string;
  usePkce: boolean;
  /** Extra authorize-URL params (provider-specific UX, e.g. account chooser). */
  extraAuthParams?: Record<string, string>;
  creds(): Creds;
  exchangeCode(args: { code: string; redirectUri: string; verifier: string }): Promise<string>;
  fetchProfile(accessToken: string): Promise<OAuthProfileResult>;
}

const FETCH_TIMEOUT_MS = 10_000;

/** Fetch JSON with a hard timeout, and never leak a provider body into a thrown message. */
async function getJson(url: string, init: RequestInit & { label: string }): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      // Status only - the response body can carry tokens or provider internals.
      throw new Error(`${init.label} failed with status ${res.status}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

// --- Google (OpenID Connect) --------------------------------------------------------

async function googleExchange(args: {
  code: string;
  redirectUri: string;
  verifier: string;
}): Promise<string> {
  const { clientId, clientSecret } = config.oauth.google;
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code: args.code,
    grant_type: 'authorization_code',
    redirect_uri: args.redirectUri,
  });
  if (args.verifier) body.set('code_verifier', args.verifier);
  const tok = await getJson('https://oauth2.googleapis.com/token', {
    label: 'google token exchange',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  if (!tok || typeof tok.access_token !== 'string') {
    throw new Error('google token exchange returned no access_token');
  }
  return tok.access_token;
}

async function googleProfile(accessToken: string): Promise<OAuthProfileResult> {
  const info = await getJson('https://openidconnect.googleapis.com/v1/userinfo', {
    label: 'google userinfo',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return {
    providerUserId: String(info.sub),
    email: typeof info.email === 'string' ? info.email : null,
    // Google returns this as a JSON boolean, but tolerate the string form too.
    emailVerified: info.email_verified === true || info.email_verified === 'true',
    displayName: String(info.name || info.given_name || ''),
  };
}

// --- GitHub -------------------------------------------------------------------------

async function githubExchange(args: {
  code: string;
  redirectUri: string;
  verifier: string;
}): Promise<string> {
  const { clientId, clientSecret } = config.oauth.github;
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code: args.code,
    redirect_uri: args.redirectUri,
  });
  const tok = await getJson('https://github.com/login/oauth/access_token', {
    label: 'github token exchange',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': 'Unote-OAuth',
    },
    body: body.toString(),
  });
  if (!tok || typeof tok.access_token !== 'string') {
    throw new Error('github token exchange returned no access_token');
  }
  return tok.access_token;
}

async function githubProfile(accessToken: string): Promise<OAuthProfileResult> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Unote-OAuth',
  };
  const user = await getJson('https://api.github.com/user', { label: 'github user', headers });

  // A GitHub email is only trustworthy if /user/emails marks it verified - user.email on
  // the profile can be an unverified or self-set address. Read the emails and pick the
  // verified primary (falling back to any verified one).
  let email: string | null = null;
  let emailVerified = false;
  try {
    const emails = await getJson('https://api.github.com/user/emails', {
      label: 'github emails',
      headers,
    });
    if (Array.isArray(emails)) {
      const chosen =
        emails.find((e: any) => e && e.primary && e.verified) ??
        emails.find((e: any) => e && e.verified);
      if (chosen && typeof chosen.email === 'string') {
        email = chosen.email;
        emailVerified = true;
      }
    }
  } catch {
    // Emails scope unavailable - fall through to the profile email below, unverified.
  }
  if (!email && typeof user.email === 'string') {
    email = user.email;
    emailVerified = false; // no verification signal for the public profile email
  }

  return {
    providerUserId: String(user.id),
    email,
    emailVerified,
    displayName: String(user.name || user.login || ''),
  };
}

// --- Registry -----------------------------------------------------------------------

export const OAUTH_PROVIDERS: Record<string, OAuthProviderDef> = {
  google: {
    id: 'google',
    label: 'Google',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    scope: 'openid email profile',
    usePkce: true,
    extraAuthParams: { access_type: 'online', prompt: 'select_account' },
    creds: () => config.oauth.google,
    exchangeCode: googleExchange,
    fetchProfile: googleProfile,
  },
  github: {
    id: 'github',
    label: 'GitHub',
    authUrl: 'https://github.com/login/oauth/authorize',
    scope: 'read:user user:email',
    // GitHub OAuth Apps do not support PKCE; the signed-state cookie is the CSRF defence.
    usePkce: false,
    creds: () => config.oauth.github,
    exchangeCode: githubExchange,
    fetchProfile: githubProfile,
  },
};

/** A provider is enabled only when BOTH its id and secret are configured. */
export function isProviderEnabled(id: string): boolean {
  const p = OAUTH_PROVIDERS[id];
  if (!p) return false;
  const { clientId, clientSecret } = p.creds();
  return Boolean(clientId && clientSecret);
}

/** The providers whose credentials are present, for the feature-flag gate. */
export function enabledProviders(): Array<{ id: string; label: string }> {
  return Object.values(OAUTH_PROVIDERS)
    .filter((p) => isProviderEnabled(p.id))
    .map((p) => ({ id: p.id, label: p.label }));
}
