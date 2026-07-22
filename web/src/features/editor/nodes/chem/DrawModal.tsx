// The "Draw" dialog: lazy-loads the Ketcher structure editor and hands the drawn molecule
// back as SMILES (+ molfile). If the optional editor packages are not installed, it degrades
// to a friendly message that points the student back to the (fully offline) typing flow.
import { useEffect, useRef, useState } from 'react';
import Modal from '../../../../components/Modal';
import { loadKetcher, type KetcherInstance, type KetcherLoad } from './ketcherLoader';

export interface DrawResult {
  smiles: string;
  molfile: string;
}

export interface DrawModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (result: DrawResult) => void;
}

type Phase = 'loading' | 'ready' | 'unavailable' | 'saving';

export default function DrawModal({ open, onClose, onSubmit }: DrawModalProps) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [loaded, setLoaded] = useState<KetcherLoad | null>(null);
  const ketcherRef = useRef<KetcherInstance | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPhase('loading');
    ketcherRef.current = null;
    loadKetcher().then((res) => {
      if (cancelled) return;
      setLoaded(res);
      setPhase(res.available ? 'ready' : 'unavailable');
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function insert() {
    const ketcher = ketcherRef.current;
    if (!ketcher) return;
    setPhase('saving');
    try {
      const [smiles, molfile] = await Promise.all([ketcher.getSmiles(), ketcher.getMolfile()]);
      onSubmit({ smiles: (smiles || '').trim(), molfile: molfile || '' });
    } catch {
      // Leave the editor open so the student does not lose their drawing.
      setPhase('ready');
    }
  }

  const Editor = loaded && loaded.available ? loaded.Editor : null;

  return (
    <Modal open={open} onClose={onClose} title="Draw a structure" width={720}>
      <div className="folio-chem-draw-modal">
        {phase === 'loading' && (
          <div className="folio-chem-draw-status" role="status">
            <span className="folio-chem-spinner" aria-hidden="true" />
            Loading the structure editor…
          </div>
        )}

        {phase === 'unavailable' && (
          <div className="folio-chem-draw-status folio-chem-draw-unavailable" role="status">
            <p className="folio-chem-draw-title">Drawing isn't turned on in this build</p>
            <p>
              You can still add a molecule by typing its SMILES string or a common name in the
              block. That works fully offline.
            </p>
          </div>
        )}

        {(phase === 'ready' || phase === 'saving') && Editor && loaded && loaded.available && (
          <>
            <div className="folio-chem-ketcher">
              <Editor
                staticResourcesUrl=""
                structServiceProvider={loaded.structServiceProvider}
                onInit={(k) => {
                  ketcherRef.current = k;
                }}
              />
            </div>
            <div className="folio-chem-draw-actions">
              <button type="button" className="folio-chem-btn" onClick={onClose} disabled={phase === 'saving'}>
                Cancel
              </button>
              <button
                type="button"
                className="folio-chem-btn folio-chem-btn-primary"
                onClick={insert}
                disabled={phase === 'saving'}
              >
                {phase === 'saving' ? 'Adding…' : 'Insert structure'}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
