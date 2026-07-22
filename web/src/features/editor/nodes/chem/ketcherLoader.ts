// Lazy, OPTIONAL loader for the "Draw" structure editor.
//
// Draw editor choice: KETCHER (EPAM) — the gold-standard open-source 2D molecule editor.
// Paired with `ketcher-standalone` it runs the Indigo cheminformatics engine as in-browser
// WASM, so drawing -> SMILES/molfile works fully OFFLINE (no server, no gateway). The trade
// off is size (~5MB incl. WASM), which is why it is never in the initial bundle: it loads
// only when a student opens the Draw dialog. Lighter alternatives were considered and
// rejected: JSME is smaller but ships a dated GWT-compiled UI with an awkward global API and
// no first-class React/TS types; Kekule.js is comparably heavy with a rougher integration.
// Since Draw is an opt-in action, deferring Ketcher's weight is the right call and its UX
// quality matters most for the students who reach for it (the ones who can't write SMILES).
//
// It is loaded through a NON-STATIC specifier so this module builds and typechecks whether or
// not ketcher-react / ketcher-standalone are installed. When they are absent, loadKetcher()
// resolves to { available: false } and the dialog shows a friendly fallback instead of
// crashing. TO ENABLE (parent/owner decision — a heavy WASM dep on a React 19 app):
//   1) npm i ketcher-react ketcher-standalone
//   2) add `import 'ketcher-react/dist/index.css'` once (e.g. in editor.css or app entry)
//   3) optionally swap the two `import(specifier)` calls below for static
//      `import('ketcher-react')` / `import('ketcher-standalone')` so Vite emits a named,
//      properly code-split chunk.

import type { ComponentType } from 'react';

export interface KetcherInstance {
  getSmiles: () => Promise<string>;
  getMolfile: () => Promise<string>;
}

// Props we rely on; Ketcher's real <Editor> accepts many more.
export interface KetcherEditorProps {
  staticResourcesUrl: string;
  structServiceProvider: unknown;
  errorHandler?: (message: string) => void;
  onInit?: (ketcher: KetcherInstance) => void;
}

export type KetcherLoad =
  | { available: true; Editor: ComponentType<KetcherEditorProps>; structServiceProvider: unknown }
  | { available: false };

let cache: Promise<KetcherLoad> | null = null;

export function loadKetcher(): Promise<KetcherLoad> {
  if (!cache) cache = doLoad();
  return cache;
}

async function doLoad(): Promise<KetcherLoad> {
  try {
    // Runtime-built specifiers: Vite cannot statically resolve these, so the build stays
    // green when the optional packages are not installed.
    const reactPkg = ['ketcher', 'react'].join('-');
    const standalonePkg = ['ketcher', 'standalone'].join('-');
    const [reactMod, standaloneMod] = await Promise.all([
      import(/* @vite-ignore */ reactPkg),
      import(/* @vite-ignore */ standalonePkg),
    ]);
    const Editor = (reactMod as { Editor?: ComponentType<KetcherEditorProps> }).Editor;
    const Provider = (standaloneMod as { StandaloneStructServiceProvider?: new () => unknown })
      .StandaloneStructServiceProvider;
    if (!Editor || !Provider) return { available: false };
    return { available: true, Editor, structServiceProvider: new Provider() };
  } catch {
    return { available: false };
  }
}
