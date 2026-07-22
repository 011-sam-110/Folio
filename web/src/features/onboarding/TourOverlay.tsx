// The guided tour overlay: a spotlight cut out of a dimmed page, plus a card that
// explains what is inside it.
//
// ACCESSIBILITY NOTES (this app went 230 axe violations -> 0; none of this may
// regress that):
//
//  * Focus is trapped by the shared `useDialogFocus` hook rather than a private
//    implementation, so Escape works from wherever focus is, Tab cannot walk out
//    into the page behind, and focus returns to the trigger on close.
//  * Focus deliberately RESTS ON THE PRIMARY BUTTON and stays there across step
//    changes, so a keyboard user advances the whole tour by pressing Enter. Moving
//    focus to the heading each step would be the more common pattern and is worse
//    here: it costs a Tab per step and interrupts the reading order.
//  * Because focus does not move, the step change is announced by a polite live
//    region carrying the full step text — otherwise a screen-reader user would hear
//    nothing at all when the content behind their focus point silently changed.
//  * The dim layer is `aria-hidden` decoration; the card is the dialog. The
//    spotlight is drawn with a huge box-shadow rather than an SVG mask so there is
//    no extra element in the accessibility tree to have to hide.
//  * prefers-reduced-motion suppresses the scroll animation and the pulse. The
//    global rule in base.css already collapses transitions, but smooth scrolling is
//    driven from JS and has to be opted out of here.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { computePosition, offset, flip, shift, autoUpdate, type Placement } from '@floating-ui/dom';
import Icon from '../../components/Icon';
import Spinner from '../../components/Spinner';
import { useNotebooks } from '../../components/NotebooksContext';
import { useDialogFocus } from '../../components/useDialogFocus';
import { toast } from '../../components/Toast';
import { errorMessage } from '../../lib/format';
import { api } from '../../lib/api';
import { TOUR_STEPS, TOUR_LENGTH, type TourStep, type TourTargets } from './tourSteps';
import { seedExampleNotebook } from './seedExample';
import { setSeeded, setTourStatus, useOnboarding } from './onboardingStore';
import './onboarding.css';

/** How long to wait for a step's target to appear before giving up on it. Covers a
 *  route change plus that page's first data load; past this the step is treated as
 *  genuinely absent rather than slow. */
const RESOLVE_TIMEOUT_MS = 2600;
const POLL_MS = 90;
/** Padding around the highlighted element, in px. */
const SPOT_PAD = 6;

type Phase = 'welcome' | 'seeding' | 'steps';
type Resolution = { status: 'locating' } | { status: 'found'; el: HTMLElement } | { status: 'centered' };

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** An element counts as a usable target only if it is actually rendered AND has a
 *  box. `offsetParent` is null for `position: fixed` elements, so client rects are
 *  the reliable test — the sidebar drawer and the canvas toolbar are both fixed. */
function isVisible(el: Element): boolean {
  const rects = el.getClientRects();
  if (rects.length === 0) return false;
  const r = rects[0];
  return r.width > 0 && r.height > 0;
}

/** Is a previously seeded notebook still in the user's vault, or did they bin it? */
async function stillExists(notebookId: string): Promise<boolean> {
  try {
    const { notebooks } = await api.notebooks();
    return notebooks.some((n) => n.id === notebookId);
  } catch {
    // Can't tell — assume it is there rather than risk creating a duplicate.
    return true;
  }
}

function findTarget(selectors: string[] | undefined): HTMLElement | null {
  if (!selectors) return null;
  for (const sel of selectors) {
    let matches: HTMLElement[];
    try {
      matches = Array.from(document.querySelectorAll<HTMLElement>(sel));
    } catch {
      continue; // a malformed selector must not take the tour down
    }
    for (const el of matches) {
      if (isVisible(el)) return el;
    }
  }
  return null;
}

export default function TourOverlay({
  resumeAt,
  onExit,
}: {
  /** Step index to resume from. -1 means "start at the welcome card". */
  resumeAt: number;
  onExit: (status: 'skipped' | 'done' | 'paused') => void;
}) {
  const navigate = useNavigate();
  // The seed creates its notebook through the raw API rather than this context, so
  // the context has to be told. Without it the sidebar keeps showing only the
  // starter notebook and step 1 spotlights a list that is missing the very thing
  // the tour just made.
  const { reload: reloadNotebooks } = useNotebooks();
  const [phase, setPhase] = useState<Phase>(resumeAt >= 0 ? 'steps' : 'welcome');
  const [index, setIndex] = useState(Math.max(0, Math.min(resumeAt, TOUR_LENGTH - 1)));
  const [resolution, setResolution] = useState<Resolution>({ status: 'locating' });
  const [spot, setSpot] = useState<Rect | null>(null);
  const [cardPos, setCardPos] = useState<{ x: number; y: number } | null>(null);
  /** Set when the highlighted element is too big to sit a card beside. */
  const [cornered, setCornered] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [seedError, setSeedError] = useState<string | null>(null);

  const cardRef = useRef<HTMLDivElement | null>(null);
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  /** Which way the user was travelling, so a skipped step skips onward in the same
   *  direction instead of bouncing them back where they came from. */
  const directionRef = useRef<1 | -1>(1);

  const isNarrow = useMediaQuery('(max-width: 700px)');
  const step: TourStep | undefined = phase === 'steps' ? TOUR_STEPS[index] : undefined;

  // Read reactively rather than snapshotting: the seed writes these ids mid-tour,
  // and the step effect below has to see them on the very next render or it
  // navigates nowhere and every seeded step falls back.
  const seeded = useOnboarding().seeded;
  const targets: TourTargets = useMemo(
    () => ({
      notebookId: seeded?.notebookId ?? null,
      noteId: seeded?.noteId ?? null,
      linkedNoteId: seeded?.linkedNoteId || null,
      canvasId: seeded?.canvasId || null,
    }),
    [seeded],
  );

  /** null until checked — drives the welcome card's wording for a repeat run. */
  const [seedSurvives, setSeedSurvives] = useState<boolean | null>(null);

  // Ask once, on the welcome card, whether last run's example is still around, so
  // the offer can describe what the button will actually do.
  useEffect(() => {
    if (phase !== 'welcome') return;
    if (!seeded) {
      setSeedSurvives(false);
      return;
    }
    let cancelled = false;
    stillExists(seeded.notebookId).then((ok) => {
      if (!cancelled) setSeedSurvives(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [phase, seeded]);

  // ---- exit paths -------------------------------------------------------------

  const exit = useCallback(
    (status: 'skipped' | 'done' | 'paused') => {
      setTourStatus(status, status === 'done' ? TOUR_LENGTH : index);
      onExit(status);
    },
    [index, onExit],
  );

  /** Escape and the close button both PAUSE rather than skip: leaving mid-tour is
   *  not the same statement as "never show me this", and the difference decides
   *  whether the next visit offers to resume. */
  const pause = useCallback(() => exit('paused'), [exit]);

  // ---- step resolution --------------------------------------------------------

  const advance = useCallback((dir: 1 | -1) => {
    directionRef.current = dir;
    setIndex((i) => i + dir);
  }, []);

  // Navigate for the current step, then hunt for its target. Steps whose target
  // never turns up either skip (pointing at nothing teaches nothing) or fall back
  // to a centred card, per their own declaration.
  useEffect(() => {
    if (phase !== 'steps') return;
    const current = TOUR_STEPS[index];

    // Ran off either end — off the top is "finished", off the bottom clamps.
    if (!current) {
      if (index >= TOUR_LENGTH) exit('done');
      else setIndex(0);
      return;
    }

    // Record progress as "in progress" on every step, so an abrupt exit — a reload,
    // a closed tab, a crash — is resumable rather than lost. A clean finish or skip
    // overwrites this with its own terminal status.
    setTourStatus('paused', index);
    setResolution({ status: 'locating' });
    setSpot(null);
    setCardPos(null);

    const wanted = current.route?.(targets) ?? null;

    // A step that declares a route but resolves to none has an unmet prerequisite —
    // in practice, the example notebook the user chose not to create. If the step
    // is one that skips when it cannot anchor, skip it NOW rather than burning the
    // full resolve timeout waiting for an element that cannot possibly appear.
    // Without this, declining the seed meant four separate ~2.6s stalls.
    if (current.route && !wanted && current.fallback === 'skip') {
      advance(directionRef.current);
      return;
    }

    if (wanted && window.location.pathname !== wanted) navigate(wanted);

    const selectors = isNarrow && current.mobileTarget ? current.mobileTarget : current.target;
    if (!selectors) {
      setResolution({ status: 'centered' });
      return;
    }

    let cancelled = false;
    const startedAt = Date.now();

    const tick = () => {
      if (cancelled) return;
      const el = findTarget(selectors);
      if (el) {
        setResolution({ status: 'found', el });
        el.scrollIntoView({
          behavior: prefersReducedMotion() ? 'auto' : 'smooth',
          block: 'center',
          inline: 'nearest',
        });
        return;
      }
      if (Date.now() - startedAt >= RESOLVE_TIMEOUT_MS) {
        if (current.fallback === 'skip') {
          // Never leave the user staring at a highlight over nothing. Skipping
          // onward is bounded: index only ever moves by one and the effect above
          // catches both ends of the array.
          advance(directionRef.current);
        } else {
          setResolution({ status: 'centered' });
        }
        return;
      }
      timer = window.setTimeout(tick, POLL_MS);
    };

    let timer = window.setTimeout(tick, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [phase, index, isNarrow, targets, navigate, advance, exit]);

  // ---- positioning ------------------------------------------------------------

  // Follow the target through scrolling, resizing and layout shifts. On narrow
  // viewports the card is a fixed bottom sheet (CSS), so only the spotlight needs
  // tracking there.
  useEffect(() => {
    if (resolution.status !== 'found') return;
    const el = resolution.el;
    const card = cardRef.current;
    const selectors = (isNarrow && step?.mobileTarget ? step.mobileTarget : step?.target) ?? [];

    const update = () => {
      // Re-query rather than trusting the captured node. React replaces subtrees
      // freely — the backlinks panel swaps its whole section when its fetch lands —
      // and a DETACHED element measures as an all-zero rect, which parked the
      // spotlight in the top-left corner and dragged the card up there with it.
      const live = findTarget(selectors);
      if (!live) return; // vanished mid-step: hold the last good position, don't jump
      if (live !== el) {
        // Rebind to the replacement; this effect re-runs and re-subscribes. Bring
        // it into view too — the node that replaced ours is often taller (a list
        // that has just filled in) and can land below the fold.
        live.scrollIntoView({
          behavior: prefersReducedMotion() ? 'auto' : 'smooth',
          block: 'center',
          inline: 'nearest',
        });
        setResolution({ status: 'found', el: live });
        return;
      }
      const r = el.getBoundingClientRect();
      setSpot({
        top: r.top - SPOT_PAD,
        left: r.left - SPOT_PAD,
        width: r.width + SPOT_PAD * 2,
        height: r.height + SPOT_PAD * 2,
      });

      // A target that fills most of the screen — the editor body, a canvas surface —
      // leaves no edge to hang a card off. floating-ui will happily place one
      // half off the bottom of the viewport, because `shift` only corrects the
      // cross axis. Dock the card to a corner instead: the spotlight already says
      // what is being talked about, so the card only has to be readable.
      const oversized = r.height > window.innerHeight * 0.55 || r.width > window.innerWidth * 0.62;
      setCornered(oversized);

      if (!card || isNarrow || oversized) {
        setCardPos(null);
        return;
      }
      const placement: Placement = step?.placement ?? 'bottom';
      computePosition(el, card, {
        strategy: 'fixed',
        placement,
        middleware: [offset(14), flip({ padding: 12 }), shift({ padding: 12 })],
      }).then(({ x, y }) => setCardPos({ x, y }));
    };

    const stop = autoUpdate(el, card ?? el, update);
    // autoUpdate watches scroll, resize and the reference's own size — but not the
    // reference being swapped for a different node, which is the common React case.
    // One cheap querySelector twice a second covers it.
    const poll = window.setInterval(update, 500);
    return () => {
      stop();
      window.clearInterval(poll);
    };
  }, [resolution, isNarrow, step]);

  // ---- announcements ----------------------------------------------------------

  useEffect(() => {
    if (phase === 'welcome') {
      setAnnouncement('Welcome to Unote. A short tour of what is here.');
      return;
    }
    if (phase !== 'steps' || !step || resolution.status === 'locating') return;
    // Full text, because focus stays put — nothing else would tell a screen-reader
    // user that the card behind their focus point had changed.
    setAnnouncement(`Step ${index + 1} of ${TOUR_LENGTH}. ${step.title}. ${step.body}`);
  }, [phase, index, step, resolution.status]);

  // Keep focus on the primary button across phase changes so Enter keeps advancing.
  useEffect(() => {
    if (phase === 'steps') primaryRef.current?.focus();
  }, [phase]);

  // ---- focus trap (shared hook, per the app's a11y contract) -------------------

  useDialogFocus(true, cardRef, pause, { trap: true, takeInitialFocus: true });

  // Left/right arrows step the tour, but only when focus is not in a text field —
  // the card has no fields today, and this keeps that true if one is ever added.
  useEffect(() => {
    if (phase !== 'steps') return;
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        advance(1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (index > 0) advance(-1);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [phase, index, advance]);

  // ---- seeding ----------------------------------------------------------------

  async function runSeed() {
    setPhase('seeding');
    setSeedError(null);
    try {
      // Replaying the tutorial must not stack up a second, third, fourth copy of
      // the example notebook. Reuse the one from last time when it is still there —
      // and only when it IS still there, because a user who deleted it and then
      // asked for the tour again plainly does want one.
      if (seeded && (await stillExists(seeded.notebookId))) {
        setPhase('steps');
        return;
      }
      const result = await seedExampleNotebook();
      setSeeded(result);
      await reloadNotebooks().catch(() => undefined);
      setPhase('steps');
    } catch (e) {
      // Do not strand the user on a spinner. Say what happened and let them carry
      // on without the example — every step that needed it degrades on its own.
      const message = errorMessage(e, 'Could not create the example notebook');
      setSeedError(message);
      toast(message, 'error');
      setPhase('welcome');
    }
  }

  function startWithoutSeed() {
    setPhase('steps');
  }

  // ---- render -----------------------------------------------------------------

  const titleId = 'folio-tour-title';
  const bodyId = 'folio-tour-body';
  const showSpotlight = resolution.status === 'found' && spot !== null;

  const anchored = !isNarrow && !cornered && cardPos !== null && resolution.status === 'found';
  const cardStyle: React.CSSProperties = anchored
    ? { position: 'fixed', top: cardPos!.y, left: cardPos!.x }
    : {};

  const cardClass = anchored
    ? 'tour-card'
    : showSpotlight && !isNarrow
      ? 'tour-card tour-card--corner' // spotlit, but the target is too big to sit beside
      : 'tour-card tour-card--centered';

  return createPortal(
    <div className="tour-root" data-narrow={isNarrow ? 'true' : undefined}>
      {/* Swallows clicks on the page behind. The tour drives navigation itself, so
          a stray click mid-step would fight it; every way out is on the card. */}
      <div className="tour-blocker" aria-hidden="true" />

      {showSpotlight && (
        <div
          className="tour-spot"
          aria-hidden="true"
          style={{ top: spot.top, left: spot.left, width: spot.width, height: spot.height }}
        />
      )}
      {!showSpotlight && <div className="tour-dim" aria-hidden="true" />}

      <div
        ref={cardRef}
        className={cardClass}
        style={cardStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        data-testid="tour-card"
        tabIndex={-1}
      >
        <div className="tour-card__head">
          <p className="tour-card__eyebrow">
            {phase === 'steps' ? `Step ${index + 1} of ${TOUR_LENGTH}` : 'Getting started'}
          </p>
          <button
            type="button"
            className="tour-card__close"
            aria-label="Close the tutorial"
            onClick={pause}
          >
            <Icon name="x" size={15} />
          </button>
        </div>

        {phase === 'steps' && (
          <div
            className="tour-progress"
            role="progressbar"
            aria-valuenow={index + 1}
            aria-valuemin={1}
            aria-valuemax={TOUR_LENGTH}
            aria-label="Tutorial progress"
          >
            <div className="tour-progress__fill" style={{ width: `${((index + 1) / TOUR_LENGTH) * 100}%` }} />
          </div>
        )}

        {phase === 'welcome' && (
          <>
            <h2 className="tour-card__title" id={titleId}>
              Welcome to Unote
            </h2>
            <p className="tour-card__body" id={bodyId}>
              There is more here than a blank page suggests: linked notes, flashcards, lecture import, canvas
              boards. This is a two-minute tour of the parts worth knowing about. You can leave at any point and
              pick it up later.
            </p>
            <div className="tour-card__seed">
              <p className="tour-card__seed-title">
                {seedSurvives ? 'Your example notebook is still here' : 'Add an example notebook first?'}
              </p>
              <p className="tour-card__seed-hint">
                {seedSurvives
                  ? 'The tour will use the “Algorithms (example)” notebook you already have, rather than making a second copy of it.'
                  : 'Creates one notebook with two short notes, a board and two flashcards, so the tour has something real to point at. It is yours. Edit or delete it like anything else.'}
              </p>
            </div>
            {seedError && (
              <p className="tour-card__error" role="alert">
                {seedError}. You can still take the tour without it.
              </p>
            )}
            <div className="tour-card__actions">
              <button type="button" className="tour-btn tour-btn--ghost" onClick={() => exit('skipped')}>
                Not now
              </button>
              <div className="tour-card__actions-main">
                <button type="button" className="tour-btn" onClick={startWithoutSeed}>
                  Use my own notes
                </button>
                <button type="button" className="tour-btn tour-btn--primary" onClick={runSeed} ref={primaryRef} data-autofocus>
                  {seedSurvives ? 'Start the tour' : 'Add example & start'}
                </button>
              </div>
            </div>
          </>
        )}

        {phase === 'seeding' && (
          <>
            <h2 className="tour-card__title" id={titleId}>
              Setting up your example
            </h2>
            <p className="tour-card__body" id={bodyId}>
              <Spinner size={14} /> Creating a notebook, two notes and a board…
            </p>
          </>
        )}

        {phase === 'steps' && step && (
          <>
            <h2 className="tour-card__title" id={titleId}>
              {step.title}
            </h2>
            <p className="tour-card__body" id={bodyId}>
              {step.body}
            </p>
            {step.code && (
              <p className="tour-card__codes">
                {step.code.map((c) => (
                  <kbd key={c}>{c}</kbd>
                ))}
              </p>
            )}
            {resolution.status === 'locating' && (
              <p className="tour-card__locating">
                <Spinner size={13} /> Taking you there…
              </p>
            )}
            <div className="tour-card__actions">
              <button type="button" className="tour-btn tour-btn--ghost" onClick={() => exit('skipped')}>
                Skip tour
              </button>
              <div className="tour-card__actions-main">
                <button
                  type="button"
                  className="tour-btn"
                  onClick={() => advance(-1)}
                  disabled={index === 0}
                >
                  Back
                </button>
                <button
                  type="button"
                  className="tour-btn tour-btn--primary"
                  onClick={() => (index + 1 >= TOUR_LENGTH ? exit('done') : advance(1))}
                  ref={primaryRef}
                  data-autofocus
                >
                  {index + 1 >= TOUR_LENGTH ? 'Finish' : 'Next'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Polite, atomic, and always mounted — a live region added at the same moment
          its text changes is not reliably announced. */}
      <div className="folio-visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </div>,
    document.body,
  );
}

/** Local matchMedia binding. The app's own `useIsMobile` lives inside App.tsx and
 *  is not exported, and this needs a different breakpoint anyway — the card becomes
 *  a bottom sheet well before the sidebar becomes a drawer. */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    mq.addEventListener('change', onChange);
    setMatches(mq.matches);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}
