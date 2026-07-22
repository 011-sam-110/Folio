// Mounts the full-screen wizard on demand (bus-driven) and refreshes the notebook list after a
// commit so new notebooks appear in the sidebar. Must be rendered inside <NotebooksProvider>,
// alongside App.tsx's existing ImportModalHost.
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNotebooks } from '../../../components/NotebooksContext';
import { _subscribeImportWizard, type OpenImportWizardArgs } from '../importWizardBus';
import ImportWizard from './ImportWizard';

export default function ImportWizardHost() {
  const [state, setState] = useState<{ open: boolean } & OpenImportWizardArgs>({ open: false });
  const { notebooks, reload } = useNotebooks();

  useEffect(() => _subscribeImportWizard((args) => setState({ open: true, ...args })), []);

  if (!state.open) return null;
  return createPortal(
    <ImportWizard
      open={state.open}
      initialSource={state.source}
      notebooks={notebooks}
      onClose={() => setState({ open: false })}
      onCommitted={() => { void reload(); }}
    />,
    document.body,
  );
}
