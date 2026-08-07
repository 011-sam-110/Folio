// The review rail: one card per suggestion, grouped by severity, beside the note.
//
// WHY SEVERITY AND NOT DOCUMENT ORDER. A run can enable eight families at once, and grammar
// alone will always produce more suggestions than accuracy does - a note has more commas in
// it than it has false claims. Ordered down the page, "this contradicts your Dijkstra note"
// arrives sixth, under five capitalisation fixes, and gets approved-all or ignored along
// with them. Severity ordering is the whole reason the catalogue carries a severity at all.
//
// Severity is NOT mapped here. It comes from the check's family in `GET /api/ai/checks`,
// which is the same catalogue the server builds its prompts from. A copy in this file would
// drift the first time a family is retuned server-side, and the rail would then be sorting
// by a rank the run did not use.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import type { AiEdit } from '../../lib/types';
import { fetchCheckCatalogue, type CheckCatalogue, type Family, type Severity } from '../../lib/checksApi';
import { toast } from '../../components/Toast';
import Icon from '../../components/Icon';
import Spinner from '../../components/Spinner';
import { inlineMarkdownToSafeHtml } from './inlineMarkdown';
import {
  activeEdits,
  approveEdit,
  clearReview,
  denyEdit,
  describeBlock,
  isApplicable,
  reviewStateOf,
  revealEdit,
  type AiReviewState,
  type AiVerdict,
} from './AiReviewPlugin';
import './aiReview.css';

/**
 * How many cards a family shows before it stops.
 *
 * Fifty-six checks on a long note can return forty suggestions, and forty cards in a rail
 * recreates - one panel to the right - exactly the wall of undifferentiated controls this
 * redesign is removing from the toolbar. The cap is per family rather than overall so a
 * flood of grammar fixes cannot push an accuracy card off the bottom.
 *
 * Nothing is ever truncated silently: a capped family renders the exact number it is
 * holding back and a control that shows them.
 */
const CARDS_PER_FAMILY = 5;

/** Bucket key for a check whose family the catalogue does not know. Prefixed so it can
 *  never collide with a real family id. */
const UNCATEGORISED = '__uncategorised';

/**
 * The rank order of the three severities.
 *
 * This is not the forbidden severity map - that is the check-to-severity assignment, which
 * only the server's catalogue makes. This is the ordering of the three labels themselves,
 * which has to be decided somewhere and cannot be derived from a list of strings.
 */
const SEVERITY_RANK: Record<Severity, number> = { critical: 0, normal: 1, minor: 2 };

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Worth checking',
  normal: 'Suggested',
  minor: 'Small fixes',
};

export interface AiReviewRailProps {
  editor: Editor | null;
  /**
   * Awaited before ANY approval writes to the document, including the first one and the
   * first of an Approve all.
   *
   * The rail does not know or care what it does - NotePage uses it to take the run's one
   * restore point, which is the only undo a review has. What matters here is the ordering:
   * the approval is dispatched after this resolves, never beside it. A restore point
   * recorded after the first edit landed would restore the reviewed note, which is worse
   * than having none at all, because History would then be offering an undo that does
   * nothing.
   *
   * Required, not optional. A default no-op would let a second caller mount this rail with
   * no undo behind it and nothing would say so.
   */
  beforeApply: () => Promise<void>;
  /** The run is over - the caller unmounts the rail. */
  onDone: () => void;
  /**
   * `panel` fills a drawer of its own; `inline` sits inside the conversation turn that
   * started the run.
   *
   * Only the chrome differs. Inline drops the sticky footer (a bar pinned to the bottom of
   * the drawer would belong to whatever is on screen, not to this run, and there can be a
   * composer under it) and puts Approve all / Discard at the end of the cards, where the
   * reader arrives after reading them. The cards, the grouping and the severity ordering are
   * the same in both, because they are the feature.
   */
  variant?: 'panel' | 'inline';
}

interface Group {
  family: Family | null;
  severity: Severity;
  edits: AiEdit[];
}

export default function AiReviewRail({ editor, beforeApply, onDone, variant = 'panel' }: AiReviewRailProps) {
  const [review, setReview] = useState<AiReviewState | null>(() => reviewStateOf(editor));
  const [catalogue, setCatalogue] = useState<CheckCatalogue | null>(null);
  const [catalogueFailed, setCatalogueFailed] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [uncapped, setUncapped] = useState<Record<string, boolean>>({});
  const [staleDismissedAt, setStaleDismissedAt] = useState(-1);

  /**
   * Every edit this run has ever shown, by id.
   *
   * `AiReviewState.pending` drops an edit the moment it is approved or denied - correct for
   * the plugin, which has no further use for it - but the rail still has to render the card
   * with its verdict on it, and that card needs the reason and the before/after text the
   * plugin no longer holds. Remembering them here keeps the plugin's state the minimum it
   * needs to be rather than growing it a second list for the benefit of one component.
   */
  const known = useRef(new Map<string, AiEdit>());

  // Mirror the plugin's state into React. `apply` returns the previous object unchanged for
  // any transaction that could not have moved a character, so a keystroke elsewhere in the
  // note costs one identity comparison here and no re-render.
  useEffect(() => {
    if (!editor) return;
    const read = () => setReview(reviewStateOf(editor));
    read();
    editor.on('transaction', read);
    return () => {
      editor.off('transaction', read);
    };
  }, [editor]);

  useEffect(() => {
    const ac = new AbortController();
    fetchCheckCatalogue(ac.signal)
      .then(setCatalogue)
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setCatalogueFailed(true);
      });
    return () => ac.abort();
  }, []);

  for (const edit of review?.pending ?? []) known.current.set(edit.id, edit);

  const pending = review ? activeEdits(review) : [];
  const settled = review?.settled ?? {};
  const staleCount = review?.stale.length ?? 0;

  /** The check's family, straight from the catalogue. Null until it loads. */
  const familyOf = useCallback(
    (edit: AiEdit): Family | null =>
      catalogue?.families.find((f) => edit.checkId === f.id || edit.checkId.startsWith(`${f.id}.`)) ?? null,
    [catalogue],
  );

  const groups = useMemo<Group[]>(() => {
    const byFamily = new Map<string, Group>();
    for (const edit of review ? activeEdits(review) : []) {
      const family = familyOf(edit);
      const key = family?.id ?? UNCATEGORISED;
      const existing = byFamily.get(key);
      if (existing) existing.edits.push(edit);
      // An edit whose family the catalogue does not know still gets a card. It cannot be
      // ranked, so it sorts with the middle severity and says so on the chip rather than
      // being hidden for the crime of being unrecognised.
      else byFamily.set(key, { family, severity: family?.severity ?? 'normal', edits: [edit] });
    }
    const order = catalogue?.families.map((f) => f.id) ?? [];
    return Array.from(byFamily.values()).sort((a, b) => {
      const rank = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      if (rank !== 0) return rank;
      return order.indexOf(a.family?.id ?? '') - order.indexOf(b.family?.id ?? '');
    });
  }, [review, catalogue, familyOf]);

  const settledIds = Object.keys(settled);

  /**
   * Approve one suggestion.
   *
   * `await beforeApply()` comes first and is the reason this is async at all: the run's
   * restore point has to be requested before the document changes, and awaiting is the only
   * way to be sure of that rather than to hope. It is cheap after the first call - the
   * caller caches the request for the run - so the second and later approvals wait on an
   * already-settled promise.
   *
   * The editor is re-checked afterwards because awaiting means time has passed, and the
   * student can navigate away or close the note inside it.
   */
  async function dispatchApprove(editId: string): Promise<void> {
    if (!editor || editor.isDestroyed) return;
    await beforeApply();
    if (!editor || editor.isDestroyed) return;
    if (!approveEdit(editor.view, editId)) {
      toast('That suggestion no longer matches the note', 'error');
    }
  }

  function dispatchDeny(editId: string): void {
    if (!editor || editor.isDestroyed) return;
    denyEdit(editor.view, editId);
  }

  /**
   * Approve everything still on the board.
   *
   * Order does not matter: each approval re-resolves the remaining suggestions against the
   * document it just produced (see AiReviewPlugin's `apply`), so an earlier approval shifting
   * every position after it is exactly the case that is already handled. What can happen is
   * that one suggestion's approval consumes text a second one quoted - that second one comes
   * back as unapplied, and is counted and reported rather than passed over.
   */
  async function approveAll(): Promise<void> {
    if (!editor || editor.isDestroyed) return;
    // The whole loop is one review, so it takes the same single restore point a one-at-a-time
    // review does - and takes it before the first of them lands.
    await beforeApply();
    if (!editor || editor.isDestroyed) return;
    let applied = 0;
    let refused = 0;
    for (const edit of pending) {
      if (approveEdit(editor.view, edit.id)) applied++;
      else refused++;
    }
    if (refused > 0) toast(`Applied ${applied}; ${refused} no longer matched the note`, 'error');
    else toast(`Applied ${applied} ${applied === 1 ? 'suggestion' : 'suggestions'}`, 'ok');
    finish();
  }

  function finish(): void {
    if (editor && !editor.isDestroyed) clearReview(editor.view);
    known.current.clear();
    onDone();
  }

  const total = pending.length;

  return (
    <aside
      className={`folio-ai-rail${variant === 'inline' ? ' folio-ai-rail--inline' : ''}`}
      aria-label="AI review"
      data-testid="ai-review-rail"
    >
      {/* Inline, the turn above already says which tool ran and how many suggestions it
          produced, and Discard in the foot already ends the run. Repeating both here put two
          headings and two ways out inside one card. */}
      {variant === 'panel' && (
        <div className="folio-ai-rail__head">
          <h3>
            <Icon name="sparkles" size={14} /> Review
          </h3>
          <span className="folio-ai-rail__count" data-testid="ai-review-count">
            {total} {total === 1 ? 'suggestion' : 'suggestions'}
          </span>
          <button type="button" className="folio-btn-icon" onClick={finish} aria-label="Close review">
            ✕
          </button>
        </div>
      )}

      {staleCount > 0 && staleCount !== staleDismissedAt && (
        <div className="folio-ai-rail__stale" data-testid="ai-review-stale">
          <span>
            {staleCount} {staleCount === 1 ? 'suggestion no longer applies' : 'suggestions no longer apply'}
          </span>
          <button type="button" onClick={() => setStaleDismissedAt(staleCount)} aria-label="Dismiss stale suggestions">
            ✕
          </button>
        </div>
      )}

      {catalogueFailed && (
        <p className="folio-ai-rail__note">
          Couldn't load the check categories, so these are in the order they came back rather than by
          severity.
        </p>
      )}

      <div className="folio-ai-rail__body">
        {!catalogue && !catalogueFailed && total > 0 && <Spinner />}

        {total === 0 && settledIds.length === 0 && (
          <p className="folio-ai-rail__empty">Nothing left to review.</p>
        )}

        {(catalogue || catalogueFailed) &&
          groups.map((group) => {
            const key = group.family?.id ?? 'uncategorised';
            const label = group.family?.label ?? 'Uncategorised';
            const isCollapsed = collapsed[key] ?? group.severity === 'minor';
            const showAll = uncapped[key] ?? false;
            const shown = showAll ? group.edits : group.edits.slice(0, CARDS_PER_FAMILY);
            const hidden = group.edits.length - shown.length;

            return (
              <section className="folio-ai-group" key={key} data-testid="ai-review-group" data-family={key}>
                <button
                  type="button"
                  className="folio-ai-group__head"
                  aria-expanded={!isCollapsed}
                  onClick={() => setCollapsed((c) => ({ ...c, [key]: !isCollapsed }))}
                >
                  <span className="folio-ai-group__chevron" aria-hidden="true">
                    {isCollapsed ? '▸' : '▾'}
                  </span>
                  <span className="folio-ai-group__label">{label}</span>
                  <span className="folio-ai-sev" data-severity={group.severity}>
                    {SEVERITY_LABEL[group.severity]}
                  </span>
                  <span className="folio-ai-group__count">{group.edits.length}</span>
                </button>

                {!isCollapsed && (
                  <ul className="folio-ai-cards">
                    {shown.map((edit) => (
                      <Card
                        key={edit.id}
                        edit={edit}
                        editor={editor}
                        familyLabel={label}
                        severity={group.severity}
                        applicable={!!review && isApplicable(review, edit.id)}
                        onApprove={() => void dispatchApprove(edit.id)}
                        onDeny={() => dispatchDeny(edit.id)}
                      />
                    ))}
                    {hidden > 0 && (
                      <li>
                        <button
                          type="button"
                          className="folio-ai-more"
                          data-testid="ai-review-more"
                          onClick={() => setUncapped((u) => ({ ...u, [key]: true }))}
                        >
                          {hidden} more in {label}
                        </button>
                      </li>
                    )}
                  </ul>
                )}
              </section>
            );
          })}

        {settledIds.length > 0 && (
          <section className="folio-ai-group folio-ai-group--settled" data-testid="ai-review-settled">
            <div className="folio-ai-group__head folio-ai-group__head--static">
              <span className="folio-ai-group__label">Decided</span>
              <span className="folio-ai-group__count">{settledIds.length}</span>
            </div>
            <ul className="folio-ai-cards">
              {settledIds.map((id) => {
                const edit = known.current.get(id);
                if (!edit) return null;
                return <SettledCard key={id} edit={edit} verdict={settled[id]} />;
              })}
            </ul>
          </section>
        )}
      </div>

      <div className="folio-ai-rail__foot">
        <button type="button" className="folio-btn-primary" disabled={total === 0} onClick={() => void approveAll()}>
          Approve all
        </button>
        <button type="button" className="folio-btn" onClick={finish}>
          Discard
        </button>
      </div>
    </aside>
  );
}

interface CardProps {
  edit: AiEdit;
  editor: Editor | null;
  familyLabel: string;
  severity: Severity;
  applicable: boolean;
  onApprove: () => void;
  onDeny: () => void;
}

function Card({ edit, editor, familyLabel, severity, applicable, onApprove, onDeny }: CardProps) {
  return (
    <li className="folio-ai-card" data-testid="ai-review-card" data-edit-id={edit.id} data-severity={severity}>
      <div className="folio-ai-card__head">
        <span className="folio-ai-chip" data-severity={severity}>
          {familyLabel}
        </span>
        {/* Not a link into the document's selection - clicking scrolls the decoration into
            view and leaves the caret where the reader left it, so glancing at a suggestion
            never costs them their place. */}
        <button type="button" className="folio-ai-card__block" onClick={() => revealEdit(editor, edit.id)}>
          {describeBlock(editor, edit.blockId)}
        </button>
      </div>

      {/* The reason is the card. A diff can say what changed and only the model can say why,
          which is the entire premise of reviewing suggestion by suggestion. */}
      <p className="folio-ai-card__reason">{edit.reason}</p>

      <Diff edit={edit} />

      {edit.source && (
        <p className="folio-ai-card__source">
          <Icon name="file-text" size={12} /> From {edit.source.label}
        </p>
      )}

      <div className="folio-ai-card__actions">
        {applicable ? (
          <button type="button" className="folio-ai-approve" data-testid="ai-review-approve" onClick={onApprove}>
            Approve
          </button>
        ) : (
          /* A notation block (chem / 3D / sketch) has no inline text to rewrite, so there is
             nothing an approval could do to it. The card still carries the before/after so
             the reader can make the change themselves. */
          <span className="folio-ai-card__manual" title="This is a notation block - change it in the block itself">
            Change it in the block
          </span>
        )}
        <button type="button" className="folio-ai-deny" data-testid="ai-review-deny" onClick={onDeny}>
          Deny
        </button>
      </div>
    </li>
  );
}

/**
 * Before and after, rendered as the formatting they describe rather than as the characters
 * that spell it.
 *
 * A card that shows `**fast**` is asking the reader to approve a change they cannot see: the
 * asterisks are the notation, not the proposal, and the whole review flow rests on the
 * before/after being an honest picture of what approving will do. `approveEdit` resolves the
 * same markdown through the same helper, so what this shows and what lands in the note come
 * from one conversion, not two that can drift.
 *
 * Sanitized to an inline-only allowlist inside `inlineMarkdownToSafeHtml`. The string being
 * rendered is model output, so it is untrusted by default.
 */
function Diff({ edit }: { edit: AiEdit }) {
  return (
    <div className="folio-ai-card__diff">
      {edit.before.trim() && <del dangerouslySetInnerHTML={{ __html: inlineMarkdownToSafeHtml(edit.before) }} />}
      {edit.after.trim() && <ins dangerouslySetInnerHTML={{ __html: inlineMarkdownToSafeHtml(edit.after) }} />}
    </div>
  );
}

function SettledCard({ edit, verdict }: { edit: AiEdit; verdict: AiVerdict }) {
  return (
    <li
      className="folio-ai-card folio-ai-card--settled"
      data-testid="ai-review-settled-card"
      data-edit-id={edit.id}
      data-verdict={verdict}
    >
      <p className="folio-ai-card__reason">{edit.reason}</p>
      <span className="folio-ai-verdict" data-verdict={verdict}>
        {verdict === 'approved' ? 'Approved' : 'Denied'}
      </span>
    </li>
  );
}
