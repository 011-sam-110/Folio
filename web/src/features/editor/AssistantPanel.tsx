// The AI panel - the note's ONE AI surface, in two states.
//
// It began as the study-assistant drawer (read the note plus its uploaded sources, report
// what's missing, never rewrite anything) and it still does that. What changed is that the
// action bar's `✦ AI ▾` dropdown no longer exists: Improve writing, Clean up formatting,
// Find missing content from uploads and Generate flashcards all live here now, and running
// any of the first three switches THIS panel into review mode rather than opening a second
// one beside it.
//
// That last part is the point. A review rail floating next to the note while an assistant
// drawer sat over it was two competing right-hand surfaces for one feature - the exact
// clutter this redesign exists to remove. One surface, two states: the actions you can take,
// and the run you just started. Ending the review (Discard, Approve all, or the review head's
// ✕) returns the panel to its actions view; closing the drawer leaves the run untouched, and
// reopening it comes back to the same cards, because the suggestions live in the editor's
// plugin state rather than in this component.
//
// The gap analysis at the top and `Find missing content from uploads` below it are NOT the
// same thing, and the copy says so: the first is prose you read (`POST /api/ai/gaps`), the
// second is insertions you approve one at a time (`POST /api/ai/gaps/edits`).
import { useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { api, ApiError } from '../../lib/api';
import { toast } from '../../components/Toast';
import Icon from '../../components/Icon';
import Spinner from '../../components/Spinner';
import { useDialogFocus } from '../../components/useDialogFocus';
import { markdownToSafeHtml } from './markdown';
import AiReviewRail from './AiReviewRail';
import type { Attachment } from '../../lib/types';

/**
 * Verbatim from `POST /api/ai/gaps/edits` (server/src/routes/ai.ts), which answers a note
 * with no usable uploads with exactly this sentence.
 *
 * The route's own 400 is surfaced verbatim too (NotePage's `aiError` shows the server's
 * message), and it stays reachable from here: an attachment can exist and still have no
 * extracted text, in which case the button is enabled and the server is the one that says
 * so. One sentence, one wording, whichever side of the wire it comes from.
 */
const GAPS_NO_UPLOADS = 'Import slides, a photo or a transcript first.';

export interface AssistantPanelProps {
  noteId: string;
  attachments?: Attachment[];
  open: boolean;
  onClose: () => void;
  /** Append the analysis into the note (explicit user choice). */
  onInsert: (markdown: string) => void;

  // --- The AI actions, moved here from the action bar's `✦ AI ▾` dropdown ---
  /** Non-null while any AI call is in flight; the actions disable together, because the
   *  page runs one AI request at a time and a second would race the first. */
  aiBusy: string | null;
  onImprove: () => void;
  onClean: () => void;
  onFindMissing: () => void;
  onFlashcards: (count: number) => void;
  onOpenChecks: () => void;

  // --- Review state: the same panel, showing the run it just started ---
  editor: Editor | null;
  reviewOpen: boolean;
  /** Awaited before the first approval writes - see AiReviewRail. */
  beforeApply: () => Promise<void>;
  onReviewDone: () => void;
}

type Phase = 'idle' | 'loading' | 'done' | 'error';

export default function AssistantPanel({
  noteId,
  attachments,
  open,
  onClose,
  onInsert,
  aiBusy,
  onImprove,
  onClean,
  onFindMissing,
  onFlashcards,
  onOpenChecks,
  editor,
  reviewOpen,
  beforeApply,
  onReviewDone,
}: AssistantPanelProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<{ markdown: string; model: string; sources: Array<{ name: string; kind: string }> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The flashcard count step ("How many?"), local because nothing outside this panel needs
  // to know that the button has been pressed once.
  const [flashcardStep, setFlashcardStep] = useState(false);

  const sourceCount = (attachments ?? []).filter((a) => a.status === 'ready').length;
  const hasUploads = (attachments ?? []).some((a) => a.status !== 'failed');

  async function findGaps() {
    setPhase('loading');
    setError(null);
    try {
      const res = await api.aiGaps(noteId);
      setResult(res);
      setPhase('done');
    } catch (e) {
      setError(e instanceof ApiError && e.status === 502 ? 'AI offline. Is the gateway running?' : e instanceof Error ? e.message : 'Analysis failed');
      setPhase('error');
    }
  }

  const panelRef = useRef<HTMLElement | null>(null);
  // Non-modal drawer: the note behind stays readable, so Tab is NOT trapped. But
  // focus must move in, otherwise the Escape handler below never fires (focus is
  // still on the trigger outside the panel) and the drawer is a dead end.
  useDialogFocus(open, panelRef, onClose, { trap: false });

  if (!open) return null;

  // Review mode replaces the panel's contents entirely - the rail brings its own head, its
  // own count and its own ✕ (which ends the review, not the panel). Rendering both would put
  // two headers and two close buttons in one drawer.
  if (reviewOpen) {
    return (
      <div className="folio-history-overlay">
        <aside
          ref={panelRef}
          className="folio-history-panel folio-assistant folio-ai-panel folio-ai-panel--review"
          role="dialog"
          tabIndex={-1}
          aria-label="AI review"
          data-testid="assistant-panel"
          onKeyDown={(e) => {
            // Escape closes the drawer and LEAVES the run alone: the suggestions are
            // decorations in the editor's plugin state, so reopening the panel comes back to
            // the same review rather than to a discarded one.
            if (e.key === 'Escape') onClose();
          }}
        >
          <AiReviewRail editor={editor} beforeApply={beforeApply} onDone={onReviewDone} />
        </aside>
      </div>
    );
  }

  return (
    <div className="folio-history-overlay">
      <aside
        ref={panelRef}
        className="folio-history-panel folio-assistant folio-ai-panel"
        role="dialog"
        tabIndex={-1}
        aria-label="AI"
        data-testid="assistant-panel"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <div className="folio-history-head">
          <h3>
            <Icon name="sparkles" size={14} /> AI
          </h3>
          <button type="button" className="folio-btn-icon" onClick={onClose} aria-label="Close AI panel">
            ✕
          </button>
        </div>

        <h4 className="folio-ai-panel__title">Check this note against your sources</h4>
        <p className="folio-assistant__tagline">
          Finds what's missing from your notes using your uploaded sources, and reports it as
          something to read. It never rewrites them.
        </p>

        {phase === 'idle' && (
          <div className="folio-assistant__start">
            <div className="folio-assistant__sources">
              {sourceCount > 0
                ? `Will check against ${sourceCount} uploaded source${sourceCount === 1 ? '' : 's'} attached to this note.`
                : 'No uploaded sources on this note yet, so the check will use standard topic coverage. Import a transcript or slides to make it sharper.'}
            </div>
            <button type="button" className="folio-btn-primary" onClick={findGaps} data-testid="assistant-find-gaps">
              Find gaps in this note
            </button>
          </div>
        )}

        {phase === 'loading' && (
          <div className="folio-assistant__loading" role="status">
            <Spinner size={18} />
            <span>Reading your note{sourceCount > 0 ? ' and sources' : ''}…</span>
          </div>
        )}

        {phase === 'error' && (
          <div className="folio-assistant__start">
            <div className="folio-assistant__error" role="alert">{error}</div>
            <button type="button" className="folio-btn" onClick={findGaps}>
              Retry
            </button>
          </div>
        )}

        {phase === 'done' && result && (
          <>
            {result.sources.length > 0 && (
              <div className="folio-assistant__sources">
                Checked against: {result.sources.map((s) => s.name).join(', ')}
              </div>
            )}
            <div
              className="folio-assistant__body"
              data-testid="assistant-result"
              // The analysis is the whole point of the panel; without a live region it
              // arrives silently and a screen-reader user has no cue to go read it.
              role="status"
              aria-live="polite"
              // Sanitized via DOMPurify inside markdownToSafeHtml.
              dangerouslySetInnerHTML={{ __html: markdownToSafeHtml(result.markdown) }}
            />
            <div className="folio-assistant__actions">
              <button type="button" className="folio-btn" onClick={findGaps}>
                Re-run
              </button>
              <button
                type="button"
                className="folio-btn"
                onClick={() => {
                  navigator.clipboard?.writeText(result.markdown).then(
                    () => toast('Copied', 'ok'),
                    () => toast('Could not copy', 'error'),
                  );
                }}
              >
                Copy
              </button>
              <button
                type="button"
                className="folio-btn-primary"
                onClick={() => {
                  onInsert(result.markdown);
                  toast('Added to the end of the note', 'ok');
                }}
              >
                Add to note
              </button>
            </div>
            <div className="folio-assistant__model">via {result.model}</div>
          </>
        )}

        {/* ---------- The actions that used to be the `✦ AI ▾` dropdown ----------
            Laid out flat and labelled, not folded into a second menu inside a panel: the
            reason this moved here at all was to take away a layer of hiding, and a dropdown
            in a drawer would put it straight back. */}
        <section className="folio-ai-panel__actions" aria-labelledby="folio-ai-panel-actions">
          <h4 className="folio-ai-panel__title" id="folio-ai-panel-actions">
            Suggest changes
          </h4>
          <p className="folio-ai-panel__hint">
            Every suggestion is reviewed one at a time, in this panel. Nothing is written into
            the note until you approve it.
          </p>

          <div className="folio-ai-panel__buttons">
            <button type="button" className="folio-ai-action" disabled={!!aiBusy} onClick={onImprove}>
              Improve writing
            </button>
            <button type="button" className="folio-ai-action" disabled={!!aiBusy} onClick={onClean}>
              Clean up formatting
            </button>

            {/* Live on `POST /api/ai/gaps/edits`, and disabled only where the comparison has
                no second side. The reason shown is the server's own sentence for that case
                rather than a second, differently-worded copy of it. */}
            <button
              type="button"
              className="folio-ai-action"
              disabled={!!aiBusy || !hasUploads}
              title={hasUploads ? undefined : GAPS_NO_UPLOADS}
              onClick={onFindMissing}
            >
              Find missing content from uploads
              {!hasUploads && <span className="folio-ai-action__hint">{GAPS_NO_UPLOADS}</span>}
            </button>

            {/* Flashcards writes to the deck rather than to the note, so it has no review
                and keeps the count step it has always had. */}
            {!flashcardStep ? (
              <button
                type="button"
                className="folio-ai-action"
                disabled={!!aiBusy}
                onClick={() => setFlashcardStep(true)}
              >
                Generate flashcards
              </button>
            ) : (
              <div className="folio-flashcard-count">
                <span>How many?</span>
                {[5, 8, 12].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => {
                      setFlashcardStep(false);
                      onFlashcards(n);
                    }}
                  >
                    {n}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button type="button" className="folio-ai-panel__checks" onClick={onOpenChecks}>
            Choose what to check…
          </button>
        </section>
      </aside>
    </div>
  );
}
