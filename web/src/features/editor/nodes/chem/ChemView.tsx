// React node view for the Chemistry block.
//  - Type mode: a SMILES field that live-renders a clean 2D structure as you type (offline),
//    plus an optional name field with best-effort name -> structure resolution.
//  - Draw mode: a button that lazy-loads the Ketcher editor so students who don't know SMILES
//    can draw a molecule and get SMILES (+ molfile) back.
// Invalid/empty input never throws - it shows a friendly inline hint.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { renderSmiles } from './smilesRenderer';
import {
  EXAMPLE_NAMES,
  lookupByName,
  lookupBySmiles,
  resolveNameOnline,
} from './commonMolecules';
import DrawModal, { type DrawResult } from './DrawModal';
import './chem.css';

type Status = 'empty' | 'ok' | 'invalid' | 'rendering';

function getTheme(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'light';
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'dark' || attr === 'light') return attr;
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

export default function ChemView({ node, updateAttributes, editor, selected }: NodeViewProps) {
  const editable = editor.isEditable;

  // Local input state, kept in sync with node attrs. lastSynced refs let us tell our own
  // commits apart from external changes (undo/redo/collab) so we don't fight the editor.
  const lastSyncedSmiles = useRef<string>((node.attrs.smiles as string) || '');
  const lastSyncedName = useRef<string>((node.attrs.name as string) || '');
  const [smiles, setSmiles] = useState<string>(lastSyncedSmiles.current);
  const [name, setName] = useState<string>(lastSyncedName.current);

  const [status, setStatus] = useState<Status>(lastSyncedSmiles.current.trim() ? 'rendering' : 'empty');
  const [nameHint, setNameHint] = useState<string>('');
  const [resolving, setResolving] = useState(false);
  const [drawOpen, setDrawOpen] = useState(false);
  const [theme, setThemeState] = useState<'light' | 'dark'>(getTheme());

  const svgRef = useRef<SVGSVGElement | null>(null);
  const renderTimer = useRef<number | undefined>(undefined);
  const commitTimer = useRef<number | undefined>(undefined);
  const renderToken = useRef(0);

  // ---- external attr sync (undo / redo / collaborative edits) ----
  useEffect(() => {
    const a = (node.attrs.smiles as string) || '';
    if (a !== lastSyncedSmiles.current) {
      lastSyncedSmiles.current = a;
      setSmiles(a);
    }
    const n = (node.attrs.name as string) || '';
    if (n !== lastSyncedName.current) {
      lastSyncedName.current = n;
      setName(n);
    }
  }, [node.attrs.smiles, node.attrs.name]);

  // ---- theme awareness: re-render on data-theme flip or system scheme change ----
  useEffect(() => {
    const sync = () => setThemeState(getTheme());
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    mq?.addEventListener('change', sync);
    const mo = new MutationObserver(sync);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      mq?.removeEventListener('change', sync);
      mo.disconnect();
    };
  }, []);

  const commit = useCallback(
    (next: { smiles?: string; name?: string; molfile?: string | null }) => {
      const payload: Record<string, unknown> = {};
      if (next.smiles !== undefined) {
        payload.smiles = next.smiles;
        lastSyncedSmiles.current = next.smiles;
      }
      if (next.name !== undefined) {
        payload.name = next.name;
        lastSyncedName.current = next.name;
      }
      if (next.molfile !== undefined) payload.molfile = next.molfile;
      updateAttributes(payload);
    },
    [updateAttributes],
  );

  // Latest name/commit read inside the render effect via refs, so the effect only re-runs
  // (and re-draws the structure) when the SMILES or theme actually changes - not on every
  // name keystroke or re-render.
  const nameRef = useRef(name);
  nameRef.current = name;
  const commitRef = useRef(commit);
  commitRef.current = commit;

  // ---- live render whenever the SMILES text or theme changes ----
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    window.clearTimeout(renderTimer.current);
    const trimmed = smiles.trim();
    if (!trimmed) {
      renderSmiles(svg, '', theme);
      setStatus('empty');
      return;
    }
    setStatus('rendering');
    const token = ++renderToken.current;
    renderTimer.current = window.setTimeout(() => {
      renderSmiles(svg, trimmed, theme).then((res) => {
        if (token !== renderToken.current) return; // a newer render superseded this one
        if (res.ok) {
          setStatus('ok');
          // Fill in a known name if the student hasn't set one.
          if (!nameRef.current.trim()) {
            const known = lookupBySmiles(trimmed);
            if (known) {
              setName(known.name);
              commitRef.current({ name: known.name });
            }
          }
        } else {
          setStatus('invalid');
        }
      });
    }, 170);
    return () => window.clearTimeout(renderTimer.current);
  }, [smiles, theme]);

  // ---- input handlers ----
  function onSmilesChange(value: string) {
    setSmiles(value);
    setNameHint('');
    // A hand-edited SMILES no longer matches any previously drawn molfile.
    window.clearTimeout(commitTimer.current);
    commitTimer.current = window.setTimeout(() => commit({ smiles: value, molfile: null }), 450);
  }

  function onSmilesBlur() {
    window.clearTimeout(commitTimer.current);
    commit({ smiles, molfile: null });
  }

  function onNameChange(value: string) {
    setName(value);
    setNameHint('');
    window.clearTimeout(commitTimer.current);
    commitTimer.current = window.setTimeout(() => commit({ name: value }), 450);
  }

  function onNameBlur() {
    window.clearTimeout(commitTimer.current);
    commit({ name });
  }

  const applyMolecule = useCallback(
    (nextSmiles: string, nextName: string, molfile: string | null) => {
      setSmiles(nextSmiles);
      setName(nextName);
      setNameHint('');
      commit({ smiles: nextSmiles, name: nextName, molfile });
    },
    [commit],
  );

  async function resolveName() {
    const q = name.trim();
    if (!q || resolving) return;
    const local = lookupByName(q);
    if (local) {
      applyMolecule(local.smiles, local.name, null);
      return;
    }
    setResolving(true);
    setNameHint('Looking this up…');
    const online = await resolveNameOnline(q);
    setResolving(false);
    if (online) {
      applyMolecule(online, q, null);
    } else {
      setNameHint("Couldn't find that name offline. Try a SMILES string or draw it.");
    }
  }

  function onDrawSubmit(result: DrawResult) {
    setDrawOpen(false);
    if (!result.smiles) return;
    const known = lookupBySmiles(result.smiles);
    applyMolecule(result.smiles, known ? known.name : name, result.molfile || null);
  }

  // If the student typed a common NAME into the SMILES box, offer a one-tap fix.
  const didYouMean = useMemo(() => {
    if (status !== 'invalid') return undefined;
    return lookupByName(smiles);
  }, [status, smiles]);

  const known = useMemo(() => lookupBySmiles(smiles.trim()), [smiles]);
  const captionName = name.trim() || known?.name || '';
  const captionFormula = known?.formula;
  const ariaLabel = captionName
    ? `2D structure of ${captionName}`
    : smiles.trim()
      ? `2D structure of SMILES ${smiles.trim()}`
      : 'Empty chemistry structure';

  const hasStructure = status === 'ok';

  // ---------- read-only rendering ----------
  if (!editable) {
    return (
      <NodeViewWrapper
        className={`folio-chem-node${selected ? ' is-selected' : ''}`}
        data-type="chem"
      >
        <div className="folio-chem-card folio-chem-readonly" contentEditable={false}>
          <div className="folio-chem-stage" data-state={status}>
            <svg ref={svgRef} className="folio-chem-svg" role="img" aria-label={ariaLabel} />
            {!smiles.trim() && <p className="folio-chem-empty-note">No structure</p>}
          </div>
          {(captionName || captionFormula) && (
            <p className="folio-chem-caption">
              {captionName}
              {captionFormula && <span className="folio-chem-formula"> · {captionFormula}</span>}
            </p>
          )}
        </div>
      </NodeViewWrapper>
    );
  }

  // ---------- editable rendering ----------
  return (
    <NodeViewWrapper className={`folio-chem-node${selected ? ' is-selected' : ''}`} data-type="chem">
      <div className="folio-chem-card" contentEditable={false}>
        <div className="folio-chem-controls">
          <label className="folio-chem-field folio-chem-field-smiles">
            <span className="folio-chem-label">SMILES</span>
            <input
              className="folio-chem-input"
              value={smiles}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              placeholder="e.g. C1=CC=CC=C1 (benzene)"
              aria-invalid={status === 'invalid'}
              onChange={(e) => onSmilesChange(e.target.value)}
              onBlur={onSmilesBlur}
            />
          </label>

          <button
            type="button"
            className="folio-chem-btn folio-chem-draw-btn"
            onClick={() => setDrawOpen(true)}
          >
            <span aria-hidden="true">✎</span> Draw
          </button>
        </div>

        <div className="folio-chem-controls">
          <label className="folio-chem-field folio-chem-field-name">
            <span className="folio-chem-label">Name (optional)</span>
            <input
              className="folio-chem-input"
              value={name}
              placeholder="e.g. benzene"
              onChange={(e) => onNameChange(e.target.value)}
              onBlur={onNameBlur}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  resolveName();
                }
              }}
            />
          </label>
          <button
            type="button"
            className="folio-chem-btn"
            onClick={resolveName}
            disabled={!name.trim() || resolving}
          >
            {resolving ? 'Finding…' : 'Find'}
          </button>
        </div>

        <div className="folio-chem-stage" data-state={status} aria-live="polite">
          <svg ref={svgRef} className="folio-chem-svg" role="img" aria-label={ariaLabel} />

          {status === 'empty' && (
            <div className="folio-chem-empty">
              <p className="folio-chem-empty-title">Type a SMILES string or a name to see the structure</p>
              <div className="folio-chem-examples">
                {EXAMPLE_NAMES.map((ex) => {
                  const m = lookupByName(ex);
                  return (
                    <button
                      key={ex}
                      type="button"
                      className="folio-chem-chip"
                      onClick={() => m && applyMolecule(m.smiles, m.name, null)}
                    >
                      {ex}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {status === 'invalid' && (
            <div className="folio-chem-invalid">
              <p className="folio-chem-hint">That's not a valid SMILES string yet. Keep typing, or draw it.</p>
              {didYouMean && (
                <button
                  type="button"
                  className="folio-chem-chip"
                  onClick={() => applyMolecule(didYouMean.smiles, didYouMean.name, null)}
                >
                  Insert {didYouMean.name}
                </button>
              )}
            </div>
          )}
        </div>

        {(hasStructure && (captionName || captionFormula)) && (
          <p className="folio-chem-caption">
            {captionName}
            {captionFormula && <span className="folio-chem-formula"> · {captionFormula}</span>}
          </p>
        )}

        {nameHint && <p className="folio-chem-hint">{nameHint}</p>}
      </div>

      <DrawModal open={drawOpen} onClose={() => setDrawOpen(false)} onSubmit={onDrawSubmit} />
    </NodeViewWrapper>
  );
}
