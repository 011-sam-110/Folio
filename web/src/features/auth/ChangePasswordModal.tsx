// Change-password dialog, opened from the sidebar account menu. Reuses the shared
// Modal (focus trap, Escape, scroll lock) rather than inventing a second dialog style.
import { useEffect, useState, type FormEvent } from 'react';
import Modal from '../../components/Modal';
import Spinner from '../../components/Spinner';
import { toast } from '../../components/Toast';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/format';
import { AuthAlert, Field } from './AuthShell';
import { newPasswordError } from './validation';
import './auth.css';

export default function ChangePasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<{ current?: string | null; next?: string | null; confirm?: string | null }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Never leave a typed password sitting in state behind a closed dialog.
  useEffect(() => {
    if (open) return;
    setCurrent('');
    setNext('');
    setConfirm('');
    setErrors({});
    setFormError(null);
  }, [open]);

  function validate() {
    const e = {
      current: current ? null : 'Enter your current password',
      next: newPasswordError(next),
      confirm: confirm === next ? null : "Passwords don't match",
    };
    // Reusing the old password is a no-op dressed up as a change; catch it here rather
    // than letting it silently "succeed".
    if (!e.next && next === current) e.next = 'Choose a password different from your current one';
    setErrors(e);
    return !e.current && !e.next && !e.confirm;
  }

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    setFormError(null);
    if (!validate()) return;

    setSaving(true);
    try {
      await api.changePassword({ currentPassword: current, newPassword: next });
      toast('Password changed — other devices have been signed out', 'ok');
      onClose();
    } catch (err) {
      const msg = errorMessage(err, 'Could not change your password');
      // The server's 403 is specifically about the current password, so pin it there;
      // a generic banner would leave the user hunting for which field was wrong.
      if (/current password/i.test(msg)) setErrors((prev) => ({ ...prev, current: msg }));
      else setFormError(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Change password" width={420}>
      <form className="auth-form auth-form--modal" onSubmit={onSubmit} noValidate>
        {formError && <AuthAlert message={formError} />}

        <Field
          label="Current password"
          type="password"
          value={current}
          onChange={(v) => {
            setCurrent(v);
            if (errors.current) setErrors((p) => ({ ...p, current: null }));
          }}
          autoComplete="current-password"
          error={errors.current}
          disabled={saving}
          autoFocus
        />

        <Field
          label="New password"
          type="password"
          value={next}
          onChange={(v) => {
            setNext(v);
            if (errors.next) setErrors((p) => ({ ...p, next: newPasswordError(v) }));
          }}
          autoComplete="new-password"
          placeholder="At least 8 characters"
          error={errors.next}
          disabled={saving}
        />

        <Field
          label="Confirm new password"
          type="password"
          value={confirm}
          onChange={(v) => {
            setConfirm(v);
            if (errors.confirm) setErrors((p) => ({ ...p, confirm: v === next ? null : "Passwords don't match" }));
          }}
          autoComplete="new-password"
          error={errors.confirm}
          disabled={saving}
        />

        <p className="auth-form__note">
          Changing your password signs you out everywhere else. You'll stay signed in here.
        </p>

        <div className="auth-form__actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving && <Spinner size={13} />}
            {saving ? 'Saving…' : 'Change password'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
