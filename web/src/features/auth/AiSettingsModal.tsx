// AI allowance and personal-key settings, opened from the sidebar account menu.
// Reuses the shared Modal and the auth form primitives rather than inventing a
// third dialog style.
//
// This dialog is where "AI doesn't work" gets diagnosed, so it leads with the live
// verdict rather than burying it. The original version showed only a quota bar: a user
// whose AI was completely dead - because this deployment's gateway is unreachable, or
// because their own key points somewhere wrong - saw a tidy screen saying nothing was
// wrong, saved a key, got a cheerful toast, and still had no AI anywhere in the app.
import { useEffect, useState, type FormEvent } from 'react';
import Modal from '../../components/Modal';
import Spinner from '../../components/Spinner';
import { toast } from '../../components/Toast';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/format';
import { aiUnavailableMessage, refreshAiHealth, setAiHealth, useAiHealth } from '../../lib/aiStatus';
import type { AiHealthInfo, AiUsage } from '../../lib/types';
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

/**
 * The live verdict, at the top of the dialog.
 *
 * Deliberately shown in all three states, not just the bad one. "AI is working, using
 * gemini-2.5-flash" is the confirmation a user needs after saving a key, and it is the
 * thing that turns this dialog from a form into an answer.
 */
function StatusBanner({ health }: { health: ReturnType<typeof useAiHealth> }) {
  if (health.status === 'pending') {
    return (
      <p className="auth-form__note">
        <Spinner size={13} /> Checking whether AI is working…
      </p>
    );
  }

  if (health.status === 'ok') {
    return (
      <p className="ai-settings__verdict ai-settings__verdict--ok" data-testid="ai-settings-status">
        AI is working
        {health.model ? ` (${health.model})` : ''}
        {health.source === 'own-key' ? ', using your own key.' : ', using the shared allowance.'}
      </p>
    );
  }

  const message = aiUnavailableMessage(health);
  return (
    <div className="ai-settings__verdict ai-settings__verdict--bad" data-testid="ai-settings-status" role="status">
      <strong>{message?.title ?? 'AI is not available'}</strong>
      <span className="ai-settings__verdict-detail">{message?.detail}</span>
    </div>
  );
}

export default function AiSettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [usage, setUsage] = useState<AiUsage | null>(null);
  const [loading, setLoading] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [models, setModels] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const health = useAiHealth();

  useEffect(() => {
    if (!open) {
      // Never leave a typed credential sitting in state behind a closed dialog.
      setApiKey('');
      setBaseUrl('');
      setModels('');
      setFormError(null);
      return;
    }
    setLoading(true);
    api
      .aiUsage()
      .then((u) => {
        setUsage(u);
        setBaseUrl(u.baseUrl ?? '');
        setModels(u.models.join(', '));
      })
      .catch((e: unknown) => setFormError(errorMessage(e, 'Could not load your AI usage')))
      .finally(() => setLoading(false));
  }, [open]);

  /**
   * Adopt the server's verdict on the credential that was just saved or removed.
   *
   * The app-wide health cache is what every AI control is gated on, and it is formed once
   * per page load. Leaving it alone here is the second half of the reported bug: the key
   * would be stored and usable, and the app would keep hiding AI until a reload.
   */
  function adoptHealth(next: AiHealthInfo | undefined): void {
    if (next) setAiHealth(next);
    else void refreshAiHealth();
  }

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    setFormError(null);
    if (!apiKey.trim()) {
      setFormError('Enter an API key, or close this dialog to keep using the free allowance.');
      return;
    }
    setSaving(true);
    try {
      const saved = await api.aiSaveKey(apiKey.trim(), baseUrl.trim() || undefined, models.trim() || undefined);
      adoptHealth(saved.health);
      setApiKey('');
      setUsage(await api.aiUsage());

      // The toast tells the truth about what happened, which is not always "it worked".
      // A key that saves but does not answer is the exact situation that used to be
      // reported as success and then quietly disable every AI feature in the app.
      if (saved.health?.ok) {
        toast('API key saved and working. AI is on and no longer limited.', 'ok');
      } else {
        toast('Key saved, but that endpoint did not answer. See the details above.', 'error');
      }
    } catch (e) {
      setFormError(errorMessage(e, 'Could not save your API key'));
    } finally {
      setSaving(false);
    }
  }

  async function removeKey() {
    setSaving(true);
    try {
      const removed = await api.aiDeleteKey();
      adoptHealth(removed.health);
      toast('API key removed. You are back on the free allowance.', 'ok');
      setUsage(await api.aiUsage());
      setBaseUrl('');
      setModels('');
    } catch (e) {
      setFormError(errorMessage(e, 'Could not remove your API key'));
    } finally {
      setSaving(false);
    }
  }

  const limit = usage ? bindingLimit(usage) : null;
  const pct = limit && limit.limit > 0 ? Math.min(100, Math.round((limit.used / limit.limit) * 100)) : 0;

  // The credential fields are useful to everyone, not just people who have run out: on a
  // deployment whose shared gateway is unreachable, bringing a key is the ONLY way to have
  // AI at all, and hiding the form behind "using own key: false" hid the remedy too.
  const keyForm = (
    <form onSubmit={onSubmit} noValidate>
      <p className="auth-form__note">
        Bring your own key from any OpenAI-compatible provider. It is encrypted before it is
        stored, and your calls stop counting against the free allowance.
      </p>
      {/* The contract, stated where the mistake gets made. A key on its own is assumed to
          belong to the gateway this site already uses; a key from a different provider
          needs that provider's address and model names, or every call 404s on a model
          the provider has never heard of. */}
      <p className="auth-form__note">
        A key on its own is used with this site's own AI gateway. For a key from somewhere
        else - OpenAI, Groq, OpenRouter, your own gateway - also fill in the endpoint and at
        least one model name from that provider.
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
        label="Endpoint (needed for a key from another provider)"
        type="text"
        value={baseUrl}
        onChange={setBaseUrl}
        autoComplete="off"
        placeholder="https://api.openai.com/v1"
        disabled={saving}
      />

      <Field
        label="Models to try, in order (comma separated)"
        type="text"
        value={models}
        onChange={setModels}
        autoComplete="off"
        placeholder="gpt-4o-mini, gpt-4o"
        disabled={saving}
      />

      <div className="auth-form__actions">
        <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
          Close
        </button>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving && <Spinner size={13} />}
          {saving ? 'Saving and testing…' : 'Save and test key'}
        </button>
      </div>
    </form>
  );

  return (
    <Modal open={open} onClose={onClose} title="AI settings" width={460}>
      <div className="auth-form auth-form--modal">
        <StatusBanner health={health} />

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
              {usage.baseUrl ? <> It is sent to <code>{usage.baseUrl}</code>.</> : null}
              {usage.models.length > 0 ? <> Models: <code>{usage.models.join(', ')}</code>.</> : null}
            </p>
            <div className="auth-form__actions">
              <button type="button" className="btn btn-secondary" onClick={removeKey} disabled={saving}>
                {saving && <Spinner size={13} />}
                Remove key
              </button>
            </div>
            {/* Editable in place: a saved key that does not work is exactly the case that
                needs correcting, and forcing a remove-then-re-add to change an endpoint
                would mean deleting the only working credential to fix a typo. */}
            <details className="ai-settings__replace">
              <summary>Replace this key or change its endpoint</summary>
              {keyForm}
            </details>
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

            {keyForm}
          </>
        )}
      </div>
    </Modal>
  );
}
