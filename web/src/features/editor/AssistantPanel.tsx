// Study Assistant drawer - the "IDE for learning" surface. It NEVER rewrites the note:
// it reads the note plus its uploaded source material (transcripts/slides/photos already
// attached to the note) and reports what's missing, what to double-check, and what to do
// next. The only write path is the explicit "Add to note" button, which appends the
// analysis as a callout - the student chooses that.
import { useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { toast } from '../../components/Toast';
import Icon from '../../components/Icon';
import Spinner from '../../components/Spinner';
import { useDialogFocus } from '../../components/useDialogFocus';
import { markdownToSafeHtml } from './markdown';
import type { Attachment } from '../../lib/types';

export interface AssistantPanelProps {
  noteId: string;
  attachments?: Attachment[];
  open: boolean;
  onClose: () => void;
  /** Append the analysis into the note (explicit user choice). */
  onInsert: (markdown: string) => void;
}

type Phase = 'idle' | 'loading' | 'done' | 'error';

export default function AssistantPanel({ noteId, attachments, open, onClose, onInsert }: AssistantPanelProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<{ markdown: string; model: string; sources: Array<{ name: string; kind: string }> } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sourceCount = (attachments ?? []).filter((a) => a.status === 'ready').length;

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

  return (
    <div className="folio-history-overlay">
      <aside
        ref={panelRef}
        className="folio-history-panel folio-assistant"
        role="dialog"
        tabIndex={-1}
        aria-label="Study assistant"
        data-testid="assistant-panel"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <div className="folio-history-head">
          <h3>
            <Icon name="sparkles" size={14} /> Assistant
          </h3>
          <button type="button" className="folio-btn-icon" onClick={onClose} aria-label="Close assistant">
            ✕
          </button>
        </div>

        <p className="folio-assistant__tagline">
          Finds what's missing from your notes using your uploaded sources. It never rewrites them.
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
      </aside>
    </div>
  );
}
