// web-shell — tiny event bus so any page/feature (notebook page, editor,
// sidebar) can open the shared ImportModal that App.tsx hosts, without
// prop-drilling or a second source of truth for its open state.
//
// Usage: import { openImportModal } from '../../components/importModalBus';
//        openImportModal({ notebookId: nb.id, defaultKind: 'photo' });
import type { ImportModalProps } from '../features/import/ImportModal';

export type OpenImportModalArgs = Omit<ImportModalProps, 'open' | 'onClose'>;

type Listener = (args: OpenImportModalArgs) => void;
let listener: Listener | null = null;

export function openImportModal(args: OpenImportModalArgs = {}) {
  if (!listener) {
    // The host isn't mounted yet (shouldn't happen once App.tsx renders it) —
    // fail loud in dev rather than silently doing nothing.
    console.warn('openImportModal called before the ImportModal host mounted');
    return;
  }
  listener(args);
}

/** Internal — used by App.tsx's ImportModalHost only. */
export function _subscribeImportModal(fn: Listener): () => void {
  listener = fn;
  return () => {
    if (listener === fn) listener = null;
  };
}
