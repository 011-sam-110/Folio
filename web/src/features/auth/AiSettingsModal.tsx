// AI allowance and personal-key settings, opened from the sidebar account menu.
// Reuses the shared Modal and the auth form primitives rather than inventing a
// third dialog style.
import { useEffect, useState, type FormEvent } from 'react';
import Modal from '../../components/Modal';
import Spinner from '../../components/Spinner';
import { toast } from '../../components/Toast';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/format';
import type { AiUsage } from '../../lib/types';
import { AuthAlert, Field } from './AuthShell';
import './auth.css';

function formatResetDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'next month' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
}

/**
 * Which allowance to show.
 *
 * There are two ceilings and the honest thing to display is whichever the user will
 * actually hit first. Showing the account bar to someone whose shared campus address has
 * already spent the network allowance would tell them they have plenty left, and then
 * refuse their next request.
 */
function bindingLimit(usage: AiUsage): { used: number; limit: number; remaining: number; shared: boolean } {
  const network = usage.ip.remaining < usage.user.remaining;
  const state = network ? usage.ip : usage.user;
  return { used: state.used, limit: state.limit, remaining: state.remaining, shared: network };
}

export default function AiSettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [usage, setUsage] = useState<AiUsage | null>(null);
  const [loading, setLoading] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      // Never leave a typed credential sitting in state behind a closed dialog.
      setApiKey('');
      setBaseUrl('');
      setFormError(null);
      return;
    }
    setLoading(true);
    api
      .aiUsage()
      .then((u) => {
        setUsage(u);
        setBaseUrl(u.baseUrl ?? '');
      })
      .catch((e: unknown) => setFormError(errorMessage(e, 'Could not load your AI usage')))
      .finally(() => setLoading(false));
  }, [open]);

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    setFormError(null);
    if (!apiKey.trim()) {
      setFormError('Enter an API key, or close this dialog to keep using the free allowance.');
      return;
    }
    setSaving(true);
    try {
      await api.aiSaveKey(apiKey.trim(), baseUrl.trim() || undefined);
      toast('API key saved. Your AI usage is no longer limited.', 'ok');
      setApiKey('');
      setUsage(await api.aiUsage());
    } catch (e) {
      setFormError(errorMessage(e, 'Could not save your API key'));
    } finally {
      setSaving(false);
    }
  }

  async function removeKey() {
    setSaving(true);
    try {
      await api.aiDeleteKey();
      toast('API key removed. You are back on the free allowance.', 'ok');
      setUsage(await api.aiUsage());
      setBaseUrl('');
    } catch (e) {
      setFormError(errorMessage(e, 'Could not remove your API key'));
    } finally {
      setSaving(false);
    }
  }

  const limit = usage ? bindingLimit(usage) : null;
  const pct = limit && limit.limit > 0 ? Math.min(100, Math.round((limit.used / limit.limit) * 100)) : 0;

  return (
    <Modal open={open} onClose={onClose} title="AI settings" width={460}>
      <div className="auth-form auth-form--modal">
        {formError && <AuthAlert message={formError} />}

        {loading && (
          <p className="auth-form__note">
            <Spinner size={13} /> Loading your usage…
          </p>
        )}

        {usage?.usingOwnKey && (
          <>
            <p className="ai-settings__status">
              You are using your own API key, ending <code>{usage.keyHint}</code>. Your AI usage is
              unlimited and billed to your own provider account.
            </p>
            <div className="auth-form__actions">
              <button type="button" className="btn btn-secondary" onClick={removeKey} disabled={saving}>
                {saving && <Spinner size={13} />}
                Remove key
              </button>
            </div>
          </>
        )}

        {usage && !usage.usingOwnKey && limit && (
          <>
            <p className="ai-settings__status">
              {limit.used} of {limit.limit} free AI actions used this month.
              {limit.remaining > 0
                ? ` Resets on ${formatResetDate(usage.resetAt)}.`
                : ` Your allowance resets on ${formatResetDate(usage.resetAt)}.`}
            </p>
            <div
              className="ai-settings__meter"
              role="progressbar"
              aria-valuenow={limit.used}
              aria-valuemin={0}
              aria-valuemax={limit.limit}
              aria-label="Free AI actions used this month"
            >
              <span className="ai-settings__meter-fill" style={{ width: `${pct}%` }} />
            </div>

            {/* Worth naming explicitly. Someone on halls or campus wifi can find their
                allowance spent by people they have never met, and without this they would
                reasonably read it as a bug in their own account. */}
            {limit.shared && (
              <p className="auth-form__note">
                This limit is shared with everyone on your network, so it can run down faster
                than your own use alone would explain.
              </p>
            )}

            <form onSubmit={onSubmit} noValidate>
              <p className="auth-form__note">
                Need more? Add your own API key from any OpenAI-compatible provider. It is
                encrypted before it is stored, and your calls stop counting against the free
                allowance.
              </p>

              <Field
                label="API key"
                type="password"
                value={apiKey}
                onChange={setApiKey}
                autoComplete="off"
                placeholder="sk-..."
                disabled={saving}
              />

              <Field
                label="Custom endpoint (optional)"
                type="text"
                value={baseUrl}
                onChange={setBaseUrl}
                autoComplete="off"
                placeholder="https://api.example.com/v1"
                disabled={saving}
              />

              <div className="auth-form__actions">
                <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
                  Close
                </button>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving && <Spinner size={13} />}
                  {saving ? 'Saving…' : 'Save key'}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </Modal>
  );
}
