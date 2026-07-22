// GLB / glTF backend: Google's <model-viewer> web component.
//
// This whole module (and the ~0.5 MB model-viewer bundle it pulls in) is a separate lazy
// chunk: Model3dView only ever does `import('./modelViewerMount')` after the node is scrolled
// into view or clicked, so a note that contains no glTF models never downloads any of it.
//
// The element is created imperatively rather than as JSX so no custom-element type
// augmentation is needed and the heavy import stays behind a dynamic import().
//
// CSP: <model-viewer> renders with WebGL and fetches the model over same-origin fetch from
// `/uploads/...`, which the app's `connect-src 'self'` allows. Draco / Meshopt / KTX2
// *compressed* assets are the exception - their decoders load from gstatic.com and would need
// those hosts added to the CSP; uncompressed GLB/glTF (the common case) need nothing.
import type { Model3dMount } from './viewerTypes';

// Memoised so the component registers exactly once across every model on the page.
let registered: Promise<unknown> | null = null;
function ensureModelViewer(): Promise<unknown> {
  registered ??= import('@google/model-viewer');
  return registered;
}

function messageFor(ev: Event): string {
  const detail = (ev as CustomEvent).detail as { type?: string } | undefined;
  if (detail?.type === 'loadfailure') return 'Couldn\'t load this model. The file may be corrupt or unsupported.';
  return 'Couldn\'t display this model.';
}

export const mountViewer: Model3dMount = (host, opts) => {
  let el: HTMLElement | null = null;
  let cancelled = false;

  ensureModelViewer()
    .then(() => {
      if (cancelled) return;
      el = document.createElement('model-viewer');
      el.setAttribute('src', opts.url);
      el.setAttribute('camera-controls', ''); // drag to orbit, scroll / pinch to zoom
      el.setAttribute('touch-action', 'pan-y'); // let the page still scroll vertically on touch
      el.setAttribute('interaction-prompt', 'none');
      el.setAttribute('loading', 'eager'); // activation is already gated by the node view
      el.setAttribute('reveal', 'auto');
      el.setAttribute('alt', '3D model preview');
      el.style.width = '100%';
      el.style.height = '100%';
      el.style.display = 'block';
      el.style.setProperty('--poster-color', 'transparent');
      el.addEventListener('load', () => opts.onLoad());
      el.addEventListener('error', (ev) => opts.onError(messageFor(ev)));
      host.appendChild(el);
    })
    .catch(() => {
      if (!cancelled) opts.onError('Could not load the 3D viewer.');
    });

  return () => {
    cancelled = true;
    el?.parentNode?.removeChild(el);
    el = null;
  };
};
