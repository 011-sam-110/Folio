// templates-nb — cross-feature integration point. NotePage.tsx (owned by notepage-tools)
// is not ours to edit this wave, so instead of a shared modal-host + event-bus pair
// (like components/importModalBus.ts + App.tsx's <ImportModalHost/>, which WOULD need an
// App.tsx edit we're not allowed to make), this exports a single self-contained function:
// call it from anywhere with a full Note and it mounts its own modal, no host required.
//
// Usage (from wherever a "Save as template" action lives, e.g. NotePage's ⋯ menu):
//   import { saveNoteAsTemplate } from '../templates/saveAsTemplate';
//   saveNoteAsTemplate(note);
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Note } from '../../lib/types';
import SaveAsTemplateModal from './SaveAsTemplateModal';

export function saveNoteAsTemplate(note: Note): void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  function cleanup() {
    root.unmount();
    container.remove();
  }

  root.render(createElement(SaveAsTemplateModal, { note, onDone: cleanup }));
}
