// Owner-side share management for one note or canvas.
//
// The whole design turns on one fact: POST /shares returns the raw token exactly
// once and the server stores only its hash, so if the user closes this dialog
// without copying the link, the link is gone — not "recoverable from settings",
// gone. That is the same contract as the account recovery key, so this borrows
// RecoveryKeyPanel's deliberate friction: the freshly minted link takes over the
// dialog, and dismissing it needs a copy plus an explicit acknowledgement. A
// link that gets clicked past is the same as no link at all.

import { useCallback, useEffect, useState } from 'react';
import Modal from '../../components/Modal';
import Icon from '../../components/Icon';
import Spinner from '../../components/Spinner';
import { toast } from '../../components/Toast';
import { api } from '../../lib/api';
import { errorMessage, relativeTime } from '../../lib/format';
import type { NoteKind, ShareCreated, ShareLink, SharePermission } from '../../lib/types';
import './share.css';

export interface ShareDialogProps {
  open: boolean;
  onClose: () => void;
  noteId: string;
  noteTitle: string;
  kind: NoteKind;
  /** Lets the header badge follow link creation/revocation without a refetch. */
  onCountChange?: (count: number) => void;
}

const MIN_PASSWORD = 4;

export default function ShareDialog({ open, onClose, noteId, noteTitle, kind, onCountChange }: ShareDialogProps) {
  const [links, setLinks] = useState<ShareLink[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [permission, setPermission] = useState<SharePermission>('edit');
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState('');
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  // The one-time reveal. Non-null means the dialog is showing a link that exists
  // nowhere else.
  const [minted, setMinted] = useState<ShareCreated | null>(null);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const { shares } = await api.shares(noteId);
      setLinks(shares);
      onCountChange?.(shares.length);
    } catch (e) {
      setLoadError(errorMessage(e, 'Could not load the links for this note'));
      setLinks([]);
    }
  }, [noteId, onCountChange]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  // Reset the form (but never the reveal — see close()) each time the dialog opens,
  // so a previous session's half-typed password does not linger.
  useEffect(() => {
    if (!open) return;
    setPermission('edit');
    setUsePassword(false);
    setPassword('');
  }, [open]);

  async function create() {
    if (creating) return;
    const pw = usePassword ? password.trim() : '';
    if (usePassword && pw.length < MIN_PASSWORD) {
      toast(`A share password needs at least ${MIN_PASSWORD} characters`, 'error');
      return;
    }
    setCreating(true);
    try {
      const res = await api.createShare(noteId, { permission, ...(pw ? { password: pw } : {}) });
      setMinted(res);
      setPassword('');
      setUsePassword(false);
      await load();
    } catch (e) {
      toast(errorMessage(e, 'Could not create a link'), 'error');
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string) {
    setRevoking(id);
    try {
      await api.revokeShare(id);
      toast('Link revoked — it no longer opens', 'ok');
      await load();
    } catch (e) {
      toast(errorMessage(e, 'Could not revoke that link'), 'error');
    } finally {
      setRevoking(null);
    }
  }

  /** Guard the close: an un-acknowledged reveal is the one state where closing
   *  loses something the user cannot get back. */
  function close() {
    if (minted) return;
    onClose();
  }

  const label = kind === 'canvas' ? 'canvas' : 'note';

  return (
    <Modal open={open} onClose={close} title={minted ? 'Copy your link now' : `Share this ${label}`} width={520}>
      {minted ? (
        <MintedLink
          minted={minted}
          permission={minted.share.permission}
          onDone={() => setMinted(null)}
        />
      ) : (
        <div className="sh-dialog">
          <p className="sh-dialog__lede">
            Anyone with the link can open <strong>{noteTitle || 'Untitled'}</strong> — no Folio account
            needed. They pick a display name when they join.
          </p>

          <fieldset className="sh-perm">
            <legend className="field-label">What can they do?</legend>
            <label className={`sh-perm__opt${permission === 'edit' ? ' is-active' : ''}`}>
              <input
                type="radio"
                name="sh-perm"
                checked={permission === 'edit'}
                onChange={() => setPermission('edit')}
              />
              <span className="sh-perm__body">
                <span className="sh-perm__title">Can edit</span>
                <span className="sh-perm__hint">
                  {kind === 'canvas' ? 'Draw on the board and rename it' : 'Edit the text and the title'}
                </span>
              </span>
            </label>
            <label className={`sh-perm__opt${permission === 'view' ? ' is-active' : ''}`}>
              <input
                type="radio"
                name="sh-perm"
                checked={permission === 'view'}
                onChange={() => setPermission('view')}
              />
              <span className="sh-perm__body">
                <span className="sh-perm__title">Can view</span>
                <span className="sh-perm__hint">Read only — they see updates but cannot change anything</span>
              </span>
            </label>
          </fieldset>

          <label className="sh-check">
            <input type="checkbox" checked={usePassword} onChange={(e) => setUsePassword(e.target.checked)} />
            <span>Require a password</span>
          </label>

          {usePassword && (
            <input
              className="text-input"
              type="text"
              value={password}
              autoFocus
              placeholder={`At least ${MIN_PASSWORD} characters`}
              aria-label="Share password"
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void create();
              }}
            />
          )}

          <button type="button" className="btn btn-primary sh-dialog__create" onClick={create} disabled={creating}>
            {creating ? <Spinner size={13} /> : <Icon name="link" size={15} />}
            Create link
          </button>

          <div className="sh-existing">
            <h3 className="sh-existing__heading">
              Active links
              {links && links.length > 0 && <span className="sh-existing__count">{links.length}</span>}
            </h3>

            {links === null && <p className="sh-existing__empty">Loading…</p>}
            {loadError && <p className="sh-existing__error">{loadError}</p>}

            {links !== null && links.length === 0 && !loadError && (
              <p className="sh-existing__empty">No links yet. This {label} is private to you.</p>
            )}

            {links?.map((s) => (
              <div key={s.id} className="sh-link">
                <span className={`sh-link__badge sh-link__badge--${s.permission}`}>
                  {s.permission === 'edit' ? 'Can edit' : 'View only'}
                </span>
                <span className="sh-link__meta">
                  Created {relativeTime(s.createdAt)}
                  {s.hasPassword && (
                    <>
                      {' · '}
                      <Icon name="lock" size={11} /> password
                    </>
                  )}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm sh-link__revoke"
                  onClick={() => revoke(s.id)}
                  disabled={revoking === s.id}
                >
                  {revoking === s.id ? 'Revoking…' : 'Revoke'}
                </button>
              </div>
            ))}

            {links !== null && links.length > 0 && (
              // Said plainly because it is the single most surprising thing about
              // this feature, and the moment to say it is while looking at the list
              // you cannot read the links out of.
              <p className="sh-existing__note">
                Links can be revoked but never re-read — only a hash of each one is stored.
              </p>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

/** The one-time reveal. Mirrors RecoveryKeyPanel: copy, acknowledge, then leave. */
function MintedLink({
  minted,
  permission,
  onDone,
}: {
  minted: ShareCreated;
  permission: SharePermission;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  // The server returns a path; the shareable thing is the absolute URL.
  const url = `${window.location.origin}${minted.url}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Clipboard access can be refused (insecure context, permission policy).
      // The link is selectable on screen regardless, so treat this as "shown"
      // rather than trapping the user behind a copy that cannot succeed.
    }
    setCopied(true);
  };

  return (
    <div className="sh-minted">
      <div className="sh-minted__badge" aria-hidden="true">
        <Icon name="link" size={20} />
      </div>

      <h2 className="sh-minted__title">Your link is ready</h2>
      <p className="sh-minted__lede">
        Copy it now. Folio stores only a hash of this link, so{' '}
        <strong>it cannot be shown again</strong> — if you lose it you will have to create a new one.
      </p>

      <output className="sh-minted__url" aria-label="Your share link">
        {url}
      </output>

      <div className="sh-minted__actions">
        <button type="button" className="btn" onClick={copy}>
          <Icon name={copied ? 'check' : 'copy'} size={15} />
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </div>

      <p className="sh-minted__perm">
        {permission === 'edit'
          ? 'Anyone with this link can edit.'
          : 'Anyone with this link can read, but not change anything.'}
        {minted.share.hasPassword && ' They will need the password you set.'}
      </p>

      <label className="sh-minted__ack">
        <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
        <span>I’ve saved this link somewhere</span>
      </label>

      <button
        type="button"
        className="btn btn-primary sh-minted__done"
        disabled={!copied || !acknowledged}
        onClick={onDone}
      >
        Done
      </button>

      {!copied && (
        <p className="sh-minted__hint" role="status">
          Copy the link to continue.
        </p>
      )}
    </div>
  );
}
