// web-shell — confirmation dialog for destructive actions (delete, etc).
import type { ReactNode } from 'react';
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
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal open={open} onClose={onCancel} title={title} width={400}>
      <div className="folio-confirm__message">{message}</div>
      <div className="folio-confirm__actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={loading}>
          {cancelLabel}
        </button>
        <button
          type="button"
          className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
          onClick={onConfirm}
          disabled={loading}
          autoFocus
        >
          {loading && <Spinner size={13} />}
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
