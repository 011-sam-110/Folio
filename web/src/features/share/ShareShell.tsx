// Chrome for the guest screens that are NOT the live session: the join gate, the
// loading state, and the two ways a link can be dead.
//
// It carries its own wordmark and theme toggle because a guest never sees the
// sidebar that normally provides them - without this, a visitor arriving in dark
// mode would have no way to change it and no sign they were in Unote at all.

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import Icon from '../../components/Icon';
import { useTheme } from '../../lib/theme';
import './share.css';

export function ShareShell({ children }: { children: ReactNode }) {
  const [theme, , toggleTheme] = useTheme();
  return (
    <div className="sh-page">
      <button
        type="button"
        className="icon-btn sh-page__theme"
        aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        onClick={toggleTheme}
      >
        <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
      </button>
      <main className="sh-card">
        <div className="sh-card__brand">
          <span className="sh-card__mark" aria-hidden="true">
            📓
          </span>
          <span className="sh-card__wordmark">Unote</span>
        </div>
        {children}
      </main>
    </div>
  );
}

export interface DeadLinkProps {
  /** A server message to show instead of the generic explanation. */
  reason?: string;
  /**
   * True when access was lost DURING a session rather than at the door. The
   * wording differs because the user's question differs: at the door it is "does
   * this link work?", mid-session it is "what just happened to the thing I was
   * looking at?".
   */
  midSession?: boolean;
}

export function DeadLink({ reason, midSession }: DeadLinkProps) {
  return (
    <ShareShell>
      <div className="sh-dead">
        <div className="sh-dead__badge" aria-hidden="true">
          <Icon name="link" size={20} />
        </div>

        {midSession ? (
          <>
            <h1 className="sh-card__title">This link was turned off</h1>
            <p className="sh-card__subtitle">
              Whoever shared it has revoked the link, or it has expired. Anything you saved before
              now is still in their copy. Ask them for a new link to carry on.
            </p>
          </>
        ) : (
          <>
            <h1 className="sh-card__title">This link doesn’t open anything</h1>
            <p className="sh-card__subtitle">
              {reason ||
                'It may have expired, been revoked by whoever shared it, or been copied incompletely. Ask them for a fresh link.'}
            </p>
          </>
        )}

        <Link className="btn btn-secondary sh-dead__home" to="/">
          Go to Unote
        </Link>
      </div>
    </ShareShell>
  );
}
