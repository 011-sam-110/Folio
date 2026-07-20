// Password recovery via a one-time key. Renders without the app shell (see main.tsx).
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import Spinner from '../../components/Spinner';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/format';
import { useAuth } from './AuthContext';
import { AuthAlert, AuthAltLink, AuthShell, Field } from './AuthShell';
import RecoveryKeyPanel from './RecoveryKeyPanel';
import { emailError, newPasswordError } from './validation';

export default function RecoverPage() {
  const { user, refresh } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string | null; password?: string | null }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [replacementKey, setReplacementKey] = useState<string | null>(null);

  // Redeeming signs the user in, so the same redirect-suppression the signup page
  // needs applies here: the replacement key must be shown before we route away.
  if (user && !replacementKey) return <Navigate to="/" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const next = { email: emailError(email), password: newPasswordError(password) };
    setErrors(next);
    if (next.email || next.password) return;
    if (!recoveryKey.trim()) {
      setFormError('Enter your recovery key.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await api.recover({
        email: email.trim(),
        recoveryKey: recoveryKey.trim(),
        newPassword: password,
      });
      await refresh();
      setReplacementKey(res.recoveryKey);
    } catch (err) {
      setFormError(
        errorMessage(err, 'Could not verify that recovery key. Check it and try again.'),
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (replacementKey) {
    return (
      <AuthShell title="Password reset" subtitle="Your old recovery key has been used up.">
        <RecoveryKeyPanel
          recoveryKey={replacementKey}
          email={email.trim()}
          continueLabel="Open Folio"
          onContinue={() => navigate('/', { replace: true })}
        />
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Use your recovery key"
      subtitle="Folio can’t email a reset link, so the key you saved at signup is the way back in."
      footer={<AuthAltLink prompt="Remembered it?" to="/login" label="Sign in" />}
    >
      <form className="auth-form" onSubmit={onSubmit} noValidate>
        {formError && <AuthAlert message={formError} />}

        <Field
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
          error={errors.email}
          disabled={submitting}
          autoFocus
        />

        <Field
          label="Recovery key"
          type="text"
          value={recoveryKey}
          onChange={setRecoveryKey}
          placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
          autoComplete="off"
          disabled={submitting}
          hint="Case and dashes don’t matter."
        />

        <Field
          label="New password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          error={errors.password}
          disabled={submitting}
        />

        <button type="submit" className="btn btn-primary auth-submit" disabled={submitting}>
          {submitting ? <Spinner size={16} /> : null}
          {submitting ? 'Checking…' : 'Reset password'}
        </button>

        <p className="auth-note">
          Resetting signs you out everywhere else, in case someone else has been in
          your account.
        </p>
      </form>
    </AuthShell>
  );
}
