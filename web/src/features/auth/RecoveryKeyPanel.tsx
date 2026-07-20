import { useState } from 'react';
import Icon from '../../components/Icon';

/**
 * Shows a recovery key once, and makes it hard to skip past accidentally.
 *
 * The server stores only a hash, so this render is genuinely the last time the key
 * exists anywhere the user can reach. That justifies the deliberate friction: the
 * continue button stays disabled until they have copied or downloaded it and ticked
 * the acknowledgement. A key that gets clicked past is the same as no key at all,
 * and the failure only becomes visible months later when they're locked out.
 */
export default function RecoveryKeyPanel({
  recoveryKey,
  onContinue,
  continueLabel = 'Continue',
  email,
}: {
  recoveryKey: string;
  onContinue: () => void;
  continueLabel?: string;
  email?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(recoveryKey);
    } catch {
      // Clipboard access can be refused (insecure context, permission policy).
      // The key is selectable on screen regardless, so treat this as "shown"
      // rather than blocking the user behind a copy that cannot succeed.
    }
    setCopied(true);
    setSaved(true);
  };

  const download = () => {
    const body =
      `Folio recovery key\n` +
      (email ? `Account: ${email}\n` : '') +
      `\n${recoveryKey}\n\n` +
      `Use this at the sign-in screen ("Forgot your password?") to regain access.\n` +
      `It works once. Redeeming it issues a replacement.\n`;
    const url = URL.createObjectURL(new Blob([body], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'folio-recovery-key.txt';
    a.click();
    URL.revokeObjectURL(url);
    setSaved(true);
  };

  return (
    <div className="auth-recovery">
      <div className="auth-recovery__badge" aria-hidden="true">
        <Icon name="lock" size={20} />
      </div>

      <h2 className="auth-recovery__title">Save your recovery key</h2>
      <p className="auth-recovery__lede">
        Folio can’t email you a reset link, so this key is the only way back into your
        account if you forget your password. <strong>You will not see it again.</strong>
      </p>

      <output className="auth-recovery__key" aria-label="Your recovery key">
        {recoveryKey}
      </output>

      <div className="auth-recovery__actions">
        <button type="button" className="btn" onClick={copy}>
          <Icon name={copied ? 'check' : 'copy'} size={15} />
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" className="btn" onClick={download}>
          <Icon name="download" size={15} />
          Download
        </button>
      </div>

      <label className="auth-recovery__ack">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
        />
        <span>I’ve saved my recovery key somewhere safe</span>
      </label>

      <button
        type="button"
        className="btn btn-primary auth-recovery__continue"
        disabled={!saved || !acknowledged}
        onClick={onContinue}
      >
        {continueLabel}
      </button>

      {!saved && (
        <p className="auth-recovery__hint" role="status">
          Copy or download the key to continue.
        </p>
      )}
    </div>
  );
}
