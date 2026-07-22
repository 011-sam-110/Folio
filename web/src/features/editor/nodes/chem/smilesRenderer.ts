// Lazy loader + render helper for smiles-drawer (the offline 2D depiction engine).
// Kept separate so ChemView stays lean and the ~197KB (minified) engine only enters the
// bundle as its own async chunk when a Chemistry block is actually edited or viewed.
// No WASM, no network - depiction works fully offline, which is a hard requirement here.

// Type-only handle on the module's default export (the SmilesDrawer namespace class). Using
// `typeof import(...)` keeps this reference type-level, so nothing is pulled into the main chunk.
type SmilesModule = (typeof import('smiles-drawer'))['default'];
type SvgDrawerInstance = InstanceType<SmilesModule['SvgDrawer']>;

let modPromise: Promise<SmilesModule> | null = null;
let drawer: SvgDrawerInstance | null = null;

async function getDrawer(): Promise<{ mod: SmilesModule; drawer: SvgDrawerInstance }> {
  if (!modPromise) {
    modPromise = import('smiles-drawer').then((m) => (m.default ?? m) as unknown as SmilesModule);
  }
  const mod = await modPromise;
  if (!drawer) {
    // Reused across renders; the target SVG is passed per-draw.
    drawer = new mod.SvgDrawer({ padding: 16, terminalCarbons: true, compactDrawing: false });
  }
  return { mod, drawer };
}

export type RenderResult = { ok: true; empty: boolean } | { ok: false; reason: 'invalid' | 'error' };

/**
 * Draw `smiles` into the given <svg>. Returns a discriminated result instead of throwing, so
 * the caller can show a friendly inline hint for invalid input and never crash the editor.
 * An empty string clears the SVG and resolves ok+empty.
 */
export async function renderSmiles(
  svg: SVGSVGElement,
  smiles: string,
  theme: 'light' | 'dark',
): Promise<RenderResult> {
  const trimmed = smiles.trim();
  // Always start clean; smiles-drawer appends into the target element.
  svg.replaceChildren();
  if (!trimmed) return { ok: true, empty: true };

  let mod: SmilesModule;
  let d: SvgDrawerInstance;
  try {
    ({ mod, drawer: d } = await getDrawer());
  } catch {
    return { ok: false, reason: 'error' };
  }

  return new Promise<RenderResult>((resolve) => {
    let settled = false;
    const done = (r: RenderResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    try {
      mod.parse(
        trimmed,
        (tree) => {
          try {
            d.draw(tree, svg, theme);
            done({ ok: true, empty: false });
          } catch {
            done({ ok: false, reason: 'error' });
          }
        },
        () => done({ ok: false, reason: 'invalid' }),
      );
    } catch {
      done({ ok: false, reason: 'invalid' });
    }
  });
}
