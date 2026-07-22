// Sign-in screen. Renders without the app shell (see main.tsx). It is deliberately just
// the form: the product is pitched on the marketing page at "/", so this screen has one
// job and does not compete with it.
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import Spinner from '../../components/Spinner';
import { errorMessage } from '../../lib/format';
import { useAuth } from './AuthContext';
import { AuthAlert, AuthAltLink, AuthShell, Field } from './AuthShell';
import OAuthButtons, { oauthErrorMessage } from './OAuthButtons';
import { emailError, loginPasswordError } from './validation';

/** Bouncing back to an auth page after signing in would be a loop, so those are
 *  discarded in favour of the dashboard. */
function safeRedirect(from: unknown): string {
  if (typeof from !== 'string' || !from.startsWith('/')) return '/';
  if (from.startsWith('/login') || from.startsWith('/signup')) return '/';
  return from;
}

export default function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const target = safeRedirect((location.state as { from?: unknown } | null)?.from);

  // A failed OAuth attempt bounces here as /login?error=...&provider=... - turn that into
  // a readable message rather than leaving the user staring at an unexplained login page.
  const [searchParams] = useSearchParams();
  const oauthError = oauthErrorMessage(searchParams.get('error'), searchParams.get('provider'));

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string | null; password?: string | null }>({});
  // Errors only appear once a field has been left or the form submitted - validating
  // every keystroke from empty would scold someone who has typed one character.
  const [touched, setTouched] = useState<{ email?: boolean; password?: boolean }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Someone with a live session has no business on the login page.
  if (user) return <Navigate to={target} replace />;

  function validate() {
    const next = { email: emailError(email), password: loginPasswordError(password) };
    setErrors(next);
    return !next.email && !next.password;
  }

  function revalidate(field: 'email' | 'password', value: string) {
    if (!touched[field]) return;
    setErrors((prev) => ({
      ...prev,
      [field]: field === 'email' ? emailError(value) : loginPasswordError(value),
    }));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setTouched({ email: true, password: true });
    if (!validate()) return;

    setSubmitting(true);
    try {
      await login({ email: email.trim(), password });
      navigate(target, { replace: true });
    } catch (err) {
      // The server answers a bad email and a bad password identically on purpose, so
      // this stays a form-level message rather than being pinned to one field.
      setFormError(errorMessage(err, 'Could not sign in. Please try again.'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to pick up where you left off."
      footer={<AuthAltLink prompt="New to Unote?" to="/signup" label="Create an account" />}
    >
      {oauthError && <AuthAlert message={oauthError} />}
      <OAuthButtons />

      <form className="auth-form" onSubmit={onSubmit} noValidate>
        {formError && <AuthAlert message={formError} />}

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
            setErrors((prev) => ({ ...prev, password: loginPasswordError(password) }));
          }}
          autoComplete="current-password"
          placeholder="Your password"
          error={errors.password}
          disabled={submitting}
        />

        <button type="submit" className="btn btn-primary auth-submit" disabled={submitting}>
          {submitting && <Spinner size={14} />}
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>

        <Link className="auth-forgot" to="/recover">
          Forgot your password?
        </Link>
      </form>
    </AuthShell>
  );
}
