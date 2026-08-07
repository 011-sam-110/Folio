// The guest's import dialog: files in, browser-local notes out, and no pretence that it
// has become any safer to leave them here.
import { useState } from 'react';
import Modal from '../../components/Modal';
import Spinner from '../../components/Spinner';
import { toast } from '../../components/Toast';
import { useNotebooks } from '../../components/NotebooksContext';
import { errorMessage, plural } from '../../lib/format';
import { importIntoGuestStore } from './guestImport';
import './dataControls.css';

export default function GuestImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { reload } = useNotebooks();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function take(files: FileList | File[] | null) {
    if (!files || (files instanceof FileList && files.length === 0)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await importIntoGuestStore(files);
      // The sidebar reads notebooks from its own context, not from the store directly.
      await reload();
      toast(
        `${plural(res.notes, 'note')} added${res.notebooks ? ` in ${plural(res.notebooks, 'new notebook')}` : ''}. Still not saved anywhere`,
        'ok',
      );
      onClose();
    } catch (e) {
      setError(errorMessage(e, 'Could not read those files'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Import notes" width={420}>
      <div className="export-modal">
        <p className="export-modal__lead">
          Markdown files, a folder of them, or a Unote export .zip. Folder names become notebooks.
        </p>

        {error && (
          <p className="export-modal__error" role="alert">
            {error}
          </p>
        )}

        <div className="export-modal__pickers">
          <label className="btn btn-primary export-modal__go">
            {busy && <Spinner size={14} />}
            {busy ? 'Reading…' : 'Choose files'}
            <input
              type="file"
              multiple
              accept=".md,.markdown,.txt,.text,.zip"
              hidden
              disabled={busy}
              onChange={(e) => void take(e.target.files)}
            />
          </label>
          <label className="btn btn-secondary export-modal__go">
            Choose folder
            <input
              type="file"
              multiple
              hidden
              disabled={busy}
              ref={(el) => {
                if (el) {
                  el.setAttribute('webkitdirectory', '');
                  el.setAttribute('directory', '');
                }
              }}
              onChange={(e) => void take(e.target.files)}
            />
          </label>
        </div>

        <p className="export-modal__note">
          These land in this browser like everything else you write here. Make an account to save them.
        </p>
      </div>
    </Modal>
  );
}
