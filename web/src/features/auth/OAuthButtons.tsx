// Social sign-in buttons for the login + signup panels.
//
// Rendered ABOVE the email form, with an "or" divider between. Only providers the
// server reports as configured are shown - the same graceful degradation the app uses
// for AI: when nothing is available the whole section (divider included) disappears,
// so production with no credentials set shows no dead buttons.
//
// Each button is a plain link that navigates the whole page to the start route, which
// 302-redirects to the provider. It is intentionally NOT a fetch: the OAuth handshake is
// a top-level browser navigation.
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../../lib/api';
import type { AuthProviderInfo } from '../../lib/types';
import './oauth.css';

const MARKS: Record<string, ReactNode> = {
  google: <GoogleMark />,
  github: <GitHubMark />,
};

export default function OAuthButtons() {
  const [providers, setProviders] = useState<AuthProviderInfo[] | null>(null);

  useEffect(() => {
    let alive = true;
    api.authProviders().then(
      (r) => alive && setProviders(r.providers),
      // Endpoint unreachable (offline, server down): show nothing rather than a broken
      // control - the email form below still works.
      () => alive && setProviders([]),
    );
    return () => {
      alive = false;
    };
  }, []);

  // Nothing until we know, and nothing when none are configured - no divider, no dead
  // buttons. Mirrors how the app hides every AI affordance when AI is off.
  if (!providers || providers.length === 0) return null;

  return (
    <div className="oauth">
      <ul className="oauth__list">
        {providers.map((p) => (
          <li key={p.id}>
            <a className="oauth__btn" href={`/api/auth/oauth/${p.id}/start`}>
              <span className="oauth__mark" aria-hidden="true">
                {MARKS[p.id] ?? null}
              </span>
              <span className="oauth__label">Continue with {p.label}</span>
            </a>
          </li>
        ))}
      </ul>
      <div className="oauth__divider" role="separator" aria-orientation="horizontal">
        <span>or</span>
      </div>
    </div>
  );
}

/**
 * Turn a callback's `?error=` code into a sentence for the login page. Kept here so the
 * codes and their copy live next to the buttons that trigger the flow.
 */
export function oauthErrorMessage(code: string | null, provider: string | null): string | null {
  if (!code) return null;
  const name = provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : 'that provider';
  switch (code) {
    case 'oauth_denied':
      return `Sign-in with ${name} was cancelled. You can try again, or use your email and password.`;
    case 'oauth_email_unverified':
      return `Your ${name} email address isn't verified, so we couldn't sign you in that way. Verify it with ${name}, or use your email and password.`;
    case 'oauth_no_email':
      return `${name} didn't share an email address, so we couldn't sign you in. Try your email and password instead.`;
    case 'oauth_config':
      return `${name} sign-in isn't available right now. Please use your email and password.`;
    case 'oauth_failed':
    default:
      return `We couldn't finish signing in with ${name}. Please try again.`;
  }
}

// Brand marks are inline SVG (no network, and they inherit the panel's ink where the
// brand allows). The panel commits to a light parchment surface in both themes, so the
// coloured Google "G" always sits on near-white and the GitHub mark reads as its
// standard monochrome form.

function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" width="18" height="18" role="img" aria-hidden="true" focusable="false">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.964 10.706A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.997 8.997 0 0 0 0 9c0 1.452.348 2.827.957 4.038l3.007-2.332z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.962L3.964 7.294C4.672 5.167 6.656 3.58 9 3.58z"
      />
    </svg>
  );
}

function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" role="img" aria-hidden="true" focusable="false">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
