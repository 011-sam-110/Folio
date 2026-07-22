// Account creation. Renders without the app shell (see main.tsx). The pre-submit state
// is the warm hero landing (AuthLanding); the one-time recovery-key state keeps the
// focused centred card (AuthShell), since that flow must not tempt anyone to wander off.
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import Spinner from '../../components/Spinner';
import { errorMessage } from '../../lib/format';
import { useAuth } from './AuthContext';
import { AuthLanding } from './AuthLanding';
import { AuthAlert, AuthAltLink, AuthShell, Field } from './AuthShell';
import OAuthButtons from './OAuthButtons';
import RecoveryKeyPanel from './RecoveryKeyPanel';
import { emailError, newPasswordError, passwordStrength } from './validation';

function safeRedirect(from: unknown): string {
  if (typeof from !== 'string' || !from.startsWith('/')) return '/';
  if (from.startsWith('/login') || from.startsWith('/signup')) return '/';
  return from;
}

export default function SignupPage() {
  const { user, signup } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const target = safeRedirect((location.state as { from?: unknown } | null)?.from);

  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string | null; password?: string | null }>({});
  const [touched, setTouched] = useState<{ email?: boolean; password?: boolean }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [issuedKey, setIssuedKey] = useState<string | null>(null);

  // A successful signup sets `user`, which would normally satisfy the redirect
  // below and navigate away instantly — skipping straight past the one and only
  // render of the recovery key. Holding the redirect while a key is pending is
  // what makes the panel reachable at all.
  if (user && !issuedKey) return <Navigate to={target} replace />;

  if (issuedKey) {
    return (
      <AuthShell title="You’re all set" subtitle="One last thing before you start.">
        <RecoveryKeyPanel
          recoveryKey={issuedKey}
          email={email.trim()}
          continueLabel="Open Unote"
          onContinue={() => navigate(target, { replace: true })}
        />
      </AuthShell>
    );
  }

  const strength = passwordStrength(password);

  function validate() {
    const next = { email: emailError(email), password: newPasswordError(password) };
    setErrors(next);
    return !next.email && !next.password;
  }

  function revalidate(field: 'email' | 'password', value: string) {
    if (!touched[field]) return;
    setErrors((prev) => ({
      ...prev,
      [field]: field === 'email' ? emailError(value) : newPasswordError(value),
    }));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setTouched({ email: true, password: true });
    if (!validate()) return;

    setSubmitting(true);
    try {
      const name = displayName.trim();
      const { recoveryKey } = await signup({
        email: email.trim(),
        password,
        ...(name ? { displayName: name } : {}),
      });
      // Hold the user here rather than navigating: the account is already created
      // and signed in, but the recovery key is only ever sent once and would be
      // lost the moment we route away.
      setIssuedKey(recoveryKey);
    } catch (err) {
      // 409 "An account with that email already exists" is about the email specifically,
      // so it reads best attached to that field; anything else stays form-level.
      const msg = errorMessage(err, 'Could not create your account. Please try again.');
      if (/already exists/i.test(msg)) {
        setErrors((prev) => ({ ...prev, email: msg }));
        setTouched((t) => ({ ...t, email: true }));
      } else {
        setFormError(msg);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLanding
      getStarted={{ focusPanel: true }}
      secondary={
        <Link className="landing-cta__secondary" to="/login">
          Log in
        </Link>
      }
      panelTitle="Create your account"
      panelSubtitle="Your notes, notebooks and flashcards, all in one place."
      panelFooter={<AuthAltLink prompt="Already have an account?" to="/login" label="Sign in" />}
    >
      <OAuthButtons />

      <form className="auth-form" onSubmit={onSubmit} noValidate>
        {formError && <AuthAlert message={formError} />}

        <Field
          label="Name"
          type="text"
          value={displayName}
          onChange={setDisplayName}
          autoComplete="name"
          placeholder="Sam"
          optional
          disabled={submitting}
        />

        <Field
          label="Email"
          type="email"
          value={email}
          onChange={(v) => {
            setEmail(v);
            revalidate('email', v);
          }}
          onBlur={() => {
            setTouched((t) => ({ ...t, email: true }));
            setErrors((prev) => ({ ...prev, email: emailError(email) }));
          }}
          autoComplete="email"
          placeholder="you@university.ac.uk"
          error={errors.email}
          disabled={submitting}
        />

        <Field
          label="Password"
          type="password"
          value={password}
          onChange={(v) => {
            setPassword(v);
            revalidate('password', v);
          }}
          onBlur={() => {
            setTouched((t) => ({ ...t, password: true }));
            setErrors((prev) => ({ ...prev, password: newPasswordError(password) }));
          }}
          // new-password is what tells a password manager to offer to generate one.
          autoComplete="new-password"
          placeholder="At least 8 characters"
          error={errors.password}
          disabled={submitting}
          hint={<PasswordMeter value={password} strength={strength} />}
        />

        <button type="submit" className="btn btn-primary auth-submit" disabled={submitting}>
          {submitting && <Spinner size={14} />}
          {submitting ? 'Creating account…' : 'Create account'}
        </button>
      </form>
    </AuthLanding>
  );
}

function PasswordMeter({
  value,
  strength,
}: {
  value: string;
  strength: ReturnType<typeof passwordStrength>;
}) {
  // Before anything is typed there is nothing to rate — show the rule instead, so the
  // requirement is known up front rather than discovered by failing.
  if (!value) return <span className="auth-meter__rule">Use at least 8 characters.</span>;

  return (
    <div className="auth-meter" data-level={strength.level}>
      <div className="auth-meter__bars" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="auth-meter__text">
        {/* Polite: this updates on every keystroke and must not interrupt typing. */}
        <span className="auth-meter__label" aria-live="polite">
          {strength.label}
        </span>
        <span className="auth-meter__hint">{strength.hint}</span>
      </div>
    </div>
  );
}
