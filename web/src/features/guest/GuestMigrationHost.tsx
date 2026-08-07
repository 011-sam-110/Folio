// The handover: a guest just signed in, and their browser still holds notes nothing has
// ever saved. This asks what to do with them before anything can lose them.
//
// Mounted next to the routes (main.tsx) rather than on a page, because the sign-in can
// land on /login, /signup, or a redirect back from an OAuth provider, and all three end
// with the same question.
import { useEffect, useState } from 'react';
import Modal from '../../components/Modal';
import Spinner from '../../components/Spinner';
import { toast } from '../../components/Toast';
import { errorMessage } from '../../lib/format';
import { useAuth } from '../auth/AuthContext';
import { downloadGuestExport } from './guestExport';
import { clearData, hasGuestWork, readData } from './guestStore';
import { endGuest, isGuest } from './guestMode';
import { migrateGuestWork, type MigrationProgress } from './guestMigrate';
import './guest.css';

/** Session-scoped, so "not now" defers the question to the next visit rather than
 *  answering it forever. A silent forever-dismiss is how work gets lost. */
const DEFERRED_KEY = 'unote:guest:migrationDeferred';

function deferred(): boolean {
  try {
    return sessionStorage.getItem(DEFERRED_KEY) === '1';
  } catch {
    return false;
  }
}

function defer(): void {
  try {
    sessionStorage.setItem(DEFERRED_KEY, '1');
  } catch {
    // Nothing to remember it with; the prompt reappears on the next render, which is
    // the safe direction.
  }
}

export default function GuestMigrationHost() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<MigrationProgress | null>(null);
  const [counts, setCounts] = useState({ notes: 0, notebooks: 0 });

  useEffect(() => {
    if (!user) return;
    // Signing in ends guest mode immediately, so the shell is reading the real account
    // from this moment on. `keepWork: true` leaves the local copy alone - it is the
    // subject of the question below, not something to tidy away before asking.
    if (isGuest()) endGuest({ keepWork: true });
    if (!hasGuestWork() || deferred()) return;
    const data = readData();
    setCounts({ notes: data.notes.length, notebooks: data.notebooks.length });
    setOpen(true);
  }, [user]);

  if (!open || !user) return null;

  async function bringThemIn() {
    setBusy(true);
    try {
      const res = await migrateGuestWork(setProgress);
      if (res.complete) {
        toast(`${res.notesCreated} note${res.notesCreated === 1 ? '' : 's'} added to your account`, 'ok');
        setOpen(false);
      } else {
        toast(`${res.failed} could not be copied. Your unsaved copy is still here`, 'error');
      }
    } catch (e) {
      toast(errorMessage(e, 'Could not copy your notes across'), 'error');
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function downloadThem() {
    try {
      await downloadGuestExport();
      toast('Downloaded. Your notes are still here until you delete them', 'ok');
    } catch (e) {
      toast(errorMessage(e, 'Could not build the download'), 'error');
    }
  }

  function discard() {
    clearData();
    setOpen(false);
    toast('Unsaved notes deleted from this browser', 'ok');
  }

  function notNow() {
    defer();
    setOpen(false);
  }

  return (
    <Modal open onClose={notNow} title="Bring your notes with you?" width={440}>
      <div className="guest-migrate">
        <p className="guest-migrate__lead">
          You wrote {counts.notes} note{counts.notes === 1 ? '' : 's'} in {counts.notebooks} notebook
          {counts.notebooks === 1 ? '' : 's'} before making this account. None of it has been saved anywhere
          except this browser.
        </p>

        {progress && (
          <p className="guest-migrate__progress" role="status">
            Copying {progress.done} of {progress.total}…
          </p>
        )}

        <div className="guest-migrate__actions">
          <button type="button" className="btn btn-primary" onClick={bringThemIn} disabled={busy}>
            {busy && <Spinner size={14} />}
            {busy ? 'Copying…' : 'Copy them into my account'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={downloadThem} disabled={busy}>
            Download them instead
          </button>
        </div>

        <div className="guest-migrate__minor">
          <button type="button" className="guest-link" onClick={notNow} disabled={busy}>
            Not now
          </button>
          <button type="button" className="guest-link guest-link--danger" onClick={discard} disabled={busy}>
            Delete them
          </button>
        </div>

        <p className="guest-migrate__foot">
          "Not now" keeps them in this browser and asks again next time. Clearing your browser data removes
          them for good.
        </p>
      </div>
    </Modal>
  );
}
