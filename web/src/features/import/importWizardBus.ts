// Tiny event bus so any surface (dashboard, sidebar, command palette) can open the full-screen
// "Import old notes" wizard that App.tsx hosts, without prop-drilling or a second source of
// truth for its open state. Mirrors components/importModalBus.ts.
//
// Usage: import { openImportWizard } from '../import/importWizardBus';
//        openImportWizard();               // or openImportWizard({ source: 'photos' })

export interface OpenImportWizardArgs {
  /** Preselect a source tile (skips straight to its picker). */
  source?: string;
}

type Listener = (args: OpenImportWizardArgs) => void;
let listener: Listener | null = null;

export function openImportWizard(args: OpenImportWizardArgs = {}): void {
  if (!listener) {
    console.warn('openImportWizard called before the ImportWizard host mounted');
    return;
  }
  listener(args);
}

/** Internal - used by ImportWizardHost only. */
export function _subscribeImportWizard(fn: Listener): () => void {
  listener = fn;
  return () => {
    if (listener === fn) listener = null;
  };
}
