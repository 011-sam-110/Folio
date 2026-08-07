// "Choose what to check": the presets row, then one card per check family with that
// family's checks listed underneath it.
//
// Three things about this component are load-bearing rather than decorative.
//
// 1. It renders the SERVER's catalogue, fetched from `GET /api/ai/checks`. Nothing about
//    the 56 checks is written down in the web bundle (see lib/checksApi.ts), so the picker
//    cannot offer a check the prompts do not run.
// 2. It states the price before a run happens. Task 4's route issues one model request per
//    enabled family and the quota is charged per family, so the "runs 4 of 8 families" line
//    is the only warning the user gets before spending quota - which is why it is derived
//    from the live selection and the live catalogue rather than written out.
// 3. The selection is saved on every change, per notebook. There is no Save button: this is
//    a preference surface, and a preference you have to remember to save is one you lose.
import { useCallback, useEffect, useMemo, useState } from 'react';
import Modal from '../../components/Modal';
import Spinner from '../../components/Spinner';
import {
  fetchCheckCatalogue,
  resolveFamilies,
  saveFamilies,
  type CheckCatalogue,
  type Preset,
} from '../../lib/checksApi';
import './notePage.css';
import './checkPicker.css';

// Severity is a property of the family, decided once in the server catalogue. Rendering it
// here is what lets someone read the cost of turning Accuracy off rather than discovering
// it later in the rail's ordering. Colour is never the only cue - the word is always there.
// Typed by string rather than by Severity so the fallback below is real: the catalogue is
// the server's to change, and a severity this build has never heard of should render its
// own id rather than an empty chip.
const SEVERITY_LABEL: Record<string, string> = {
  critical: 'Critical',
  normal: 'Normal',
  minor: 'Minor',
};

function sameFamilies(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

export interface CheckPickerProps {
  notebookId: string;
  open: boolean;
  onClose: () => void;
}

export default function CheckPicker({ notebookId, open, onClose }: CheckPickerProps) {
  const [catalogue, setCatalogue] = useState<CheckCatalogue | null>(null);
  const [error, setError] = useState<string | null>(null);
  // `null` while the catalogue is still in flight - there is nothing to resolve a saved
  // selection against until the server has said which families exist.
  const [selected, setSelected] = useState<string[] | null>(null);
  const [retry, setRetry] = useState(0);

  // Re-fetched every time the picker opens rather than cached for the life of the page.
  // The entire reason the catalogue is served over HTTP is that it can change without a web
  // deploy, and a per-page cache would quietly reintroduce the staleness that buys back.
  useEffect(() => {
    if (!open) return;
    const ac = new AbortController();
    setError(null);
    fetchCheckCatalogue(ac.signal)
      .then((cat) => setCatalogue(cat))
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        setError(e instanceof Error ? e.message : 'Could not load the checks.');
      });
    return () => ac.abort();
  }, [open, retry]);

  useEffect(() => {
    if (!open || !catalogue) return;
    setSelected(resolveFamilies(notebookId, catalogue));
  }, [open, catalogue, notebookId]);

  const commit = useCallback(
    (next: string[]) => {
      setSelected(next);
      saveFamilies(notebookId, next);
    },
    [notebookId],
  );

  const toggleFamily = useCallback(
    (familyId: string) => {
      if (!catalogue || !selected) return;
      const on = new Set(selected);
      if (on.has(familyId)) on.delete(familyId);
      else on.add(familyId);
      // Rebuild in catalogue order so the stored array is stable no matter which order the
      // user clicked in - two identical selections then serialise identically.
      commit(catalogue.families.filter((f) => on.has(f.id)).map((f) => f.id));
    },
    [catalogue, selected, commit],
  );

  const applyPreset = useCallback(
    (preset: Preset) => {
      if (!catalogue) return;
      // Walked in catalogue order, which also drops any family id a preset names that the
      // catalogue no longer carries.
      commit(catalogue.families.filter((f) => preset.families.includes(f.id)).map((f) => f.id));
    },
    [catalogue, commit],
  );

  // Which preset (if any) the current selection happens to equal. Derived rather than
  // stored, because a preset is a starting point and not a mode: the moment the user ticks
  // one more family the answer is "Custom", and there is no state that can disagree.
  const activePreset = useMemo(
    () => (catalogue && selected ? (catalogue.presets.find((p) => sameFamilies(p.families, selected)) ?? null) : null),
    [catalogue, selected],
  );

  if (!open) return null;

  const total = catalogue?.families.length ?? 0;
  const count = selected?.length ?? 0;

  return (
    <Modal open={open} onClose={onClose} title="Choose what to check" width={760}>
      <div className="folio-check-picker" data-testid="check-picker">
        {!catalogue && !error && (
          <div className="folio-check-state">
            <Spinner size={20} />
            <span>Loading the checks…</span>
          </div>
        )}

        {error && (
          <div className="folio-check-state" role="alert">
            <p className="folio-check-state__msg">The checks could not be loaded: {error}</p>
            <button type="button" className="folio-btn" onClick={() => setRetry((n) => n + 1)}>
              Try again
            </button>
          </div>
        )}

        {catalogue && selected && (
          <>
            <section className="folio-check-presets" aria-labelledby="folio-check-presets-title">
              <h3 className="folio-check-section-title" id="folio-check-presets-title">
                Presets
              </h3>
              <div className="folio-check-presets__row">
                {catalogue.presets.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="folio-check-preset"
                    // A real toggle, so a screen reader announces which preset the current
                    // selection matches instead of leaving that to the border colour.
                    aria-pressed={activePreset?.id === p.id}
                    data-testid={`check-preset-${p.id}`}
                    onClick={() => applyPreset(p)}
                  >
                    {p.label}
                    <span className="folio-check-preset__n">
                      {p.families.length}
                      <span className="folio-visually-hidden">
                        {p.families.length === 1 ? ' family' : ' families'}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
              <p className="folio-check-help">
                A preset is a starting point, not a mode. Every family below stays adjustable
                afterwards, and whatever you settle on is remembered for this notebook — other
                notebooks keep their own.
              </p>
            </section>

            <p
              className={`folio-check-cost${count === 0 ? ' folio-check-cost--empty' : ''}`}
              // Announced because it is the only warning before quota is spent, and it
              // changes underneath the control the user is currently operating.
              role="status"
              aria-live="polite"
              data-testid="check-cost"
            >
              {count === 0 ? (
                <>
                  <strong>Nothing selected.</strong> A run would check nothing — turn on at least
                  one family.
                </>
              ) : (
                <>
                  <strong>{activePreset ? activePreset.label : 'This selection'}</strong> runs {count}{' '}
                  of {total} families. Each family is one request to the model, so a run costs{' '}
                  {count} against your AI quota.
                </>
              )}
            </p>

            <ul className="folio-check-families">
              {catalogue.families.map((f) => {
                const on = selected.includes(f.id);
                return (
                  <li key={f.id} className={`folio-check-family${on ? ' is-on' : ''}`}>
                    {/* A real checkbox inside a real label: the family name, its severity and
                        its check count all become part of the control's accessible name, and
                        the native control brings keyboard reachability and the focus ring
                        with it. */}
                    <label className="folio-check-family__head">
                      <input
                        type="checkbox"
                        className="folio-check-family__toggle"
                        checked={on}
                        data-testid={`check-family-${f.id}`}
                        onChange={() => toggleFamily(f.id)}
                      />
                      <span className="folio-check-family__name">{f.label}</span>
                      <span className="folio-check-family__severity" data-severity={f.severity}>
                        {SEVERITY_LABEL[f.severity] ?? f.severity}
                      </span>
                      <span className="folio-check-family__count">
                        {f.checks.length}
                        <span className="folio-visually-hidden"> checks</span>
                      </span>
                    </label>
                    {/* The checks stay listed even when the family is off. Turning something
                        down is a decision, and it needs to be visible what is being declined. */}
                    <ul className="folio-check-list">
                      {f.checks.map((c) => (
                        <li key={c.id}>{c.label}</li>
                      ))}
                    </ul>
                  </li>
                );
              })}
            </ul>

            <div className="folio-check-actions">
              <span className="folio-check-actions__note">Saved for this notebook as you change it.</span>
              <button type="button" className="folio-btn-primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
