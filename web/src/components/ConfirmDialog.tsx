// web-shell - confirmation dialog for destructive actions (delete, etc).
import { useEffect, useState, type ReactNode } from 'react';
import Modal from './Modal';
import Spinner from './Spinner';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  loading?: boolean;
  /** When set, the user must type this exact text before Confirm enables - used for
   *  hard-deletes with no undo (e.g. deleting a whole notebook). */
  requireText?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  loading = false,
  requireText,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('');

  // Reset the typed text whenever the dialog opens/closes.
  useEffect(() => {
    if (!open) setTyped('');
  }, [open]);

  const confirmBlocked = !!requireText && typed.trim() !== requireText;

  return (
    <Modal open={open} onClose={onCancel} title={title} width={400}>
      <div className="folio-confirm__message">{message}</div>
      {requireText && (
        <label className="folio-confirm__challenge">
          <span>
            Type <strong>{requireText}</strong> to confirm
          </span>
          <input
            className="text-input"
            value={typed}
            placeholder={requireText}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !confirmBlocked && !loading) onConfirm();
            }}
          />
        </label>
      )}
      <div className="folio-confirm__actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={loading}>
          {cancelLabel}
        </button>
        <button
          type="button"
          className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
          onClick={onConfirm}
          disabled={loading || confirmBlocked}
          autoFocus={!requireText}
        >
          {loading && <Spinner size={13} />}
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
