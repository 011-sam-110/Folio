// First-run hints: one small, dismissible bubble pointing at an affordance you
// would otherwise have to already know about.
//
// THE ANTI-NAG RULES, which are the whole design:
//
//  1. Four hints exist. Each is shown at most ONCE, EVER, per account per device.
//     Dismissal is written to storage the moment it happens.
//  2. Never more than one on screen. A second hint waits for its own next visit.
//  3. Nothing appears while the tutorial is running, or in the same session the
//     tutorial ended - someone who has just been walked round the app does not then
//     want tooltips explaining the same things.
//  4. A hint only appears once its target has been continuously on screen for a
//     moment. Without that, hints flash during route transitions and read as noise.
//  5. Hints resolve by TARGET PRESENCE, not just route. A hint whose element is not
//     on this screen simply does not appear, so a narrow viewport or a hidden AI
//     affordance costs nothing.
//
// Hints are hosted centrally here, driven off the route, rather than being sprinkled
// through the page components - that keeps the "only one at a time" rule enforceable
// in one place instead of by convention.
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { computePosition, offset, flip, shift, autoUpdate, type Placement } from '@floating-ui/dom';
import Icon from '../../components/Icon';
import { dismissHint, useOnboarding } from './onboardingStore';
import type { HintId } from './hintIds';
import './onboarding.css';

/** Set when the tour exits, so hints stay quiet for the rest of that page load. */
let suppressedForSession = false;

export function suppressHintsThisSession(): void {
  suppressedForSession = true;
}

interface HintDef {
  id: HintId;
  /** Matched against the pathname. */
  match: (pathname: string) => boolean;
  /** Tried in order; first visible one anchors the bubble. */
  target: string[];
  title: string;
  body: string;
  placement?: Placement;
}

const HINTS: HintDef[] = [
  {
    id: 'canvas-ink-v1',
    // Canvas boards live on /note/:id too - the target decides, not the route.
    match: (p) => p.startsWith('/note/'),
    target: ['[data-tour="canvas-tools"]', '.cv-tools'],
    title: 'A stylus draws, a finger pans',
    body: 'Pick up the pen and draw straight onto the board. Resting your palm on the screen will not leave a mark. Drawing with a finger is off by default, but there is a toggle in the pen toolbar if you want it.',
    placement: 'bottom',
  },
  {
    id: 'editor-slash-v1',
    match: (p) => p.startsWith('/note/'),
    target: ['[data-testid="note-editor"]'],
    title: 'Two keystrokes worth knowing',
    body: 'Type / on an empty line for headings, lists, tables, code and callouts. Type [[ to link another note by name. The note you link to will list this one in its backlinks.',
    placement: 'top',
  },
  {
    id: 'search-operators-v1',
    match: (p) => p.startsWith('/search'),
    target: ['[data-tour="search-box"]', '.sr-search-box'],
    title: 'Search takes operators',
    body: 'Narrow a search with tag:algorithms, notebook:"Operating Systems", "an exact phrase", or a leading minus to exclude a word. They combine.',
    placement: 'bottom',
  },
];

// A fourth hint pointing at the sidebar's command-palette button was cut. Its
// anchor sits in the very bottom-left corner, so `shift()` pushed the bubble up
// over the account menu trigger - and a non-modal hint that covers a control the
// user is trying to click is worse than no hint. The palette is not undiscovered
// anyway: the sidebar search box already shows a ⌘K chip, the tour has a step on
// it, and it is in the cheatsheet. Three hints, each shown once, is also simply
// less noise than four.

function findVisible(selectors: string[]): HTMLElement | null {
  for (const sel of selectors) {
    let matches: HTMLElement[];
    try {
      matches = Array.from(document.querySelectorAll<HTMLElement>(sel));
    } catch {
      continue;
    }
    for (const el of matches) {
      const r = el.getClientRects();
      if (r.length > 0 && r[0].width > 0 && r[0].height > 0) return el;
    }
  }
  return null;
}

export default function HintHost({ tourRunning }: { tourRunning: boolean }) {
  const { pathname } = useLocation();
  const state = useOnboarding();
  const [active, setActive] = useState<{ def: HintDef; el: HTMLElement } | null>(null);

  // Hints are for people who are past the tutorial - either they finished it, skipped
  // it, or the account predates it. Someone mid-tour gets nothing.
  const eligible =
    !tourRunning && !suppressedForSession && (state.status === 'done' || state.status === 'skipped');

  useEffect(() => {
    if (!eligible) {
      setActive(null);
      return;
    }
    if (active) return; // one at a time

    const candidates = HINTS.filter((h) => !state.hints[h.id] && h.match(pathname));
    if (candidates.length === 0) return;

    // Require the target to hold still before interrupting: poll, and only fire once
    // the same element has been present across the settle window.
    let elapsed = 0;
    let stableFor = 0;
    let lastEl: HTMLElement | null = null;
    const STEP = 150;
    const SETTLE = 1200;
    const GIVE_UP = 8000;

    const timer = window.setInterval(() => {
      elapsed += STEP;
      let found: { def: HintDef; el: HTMLElement } | null = null;
      for (const def of candidates) {
        const el = findVisible(def.target);
        if (el) {
          found = { def, el };
          break;
        }
      }
      if (!found) {
        stableFor = 0;
        lastEl = null;
        if (elapsed >= GIVE_UP) window.clearInterval(timer);
        return;
      }
      stableFor = found.el === lastEl ? stableFor + STEP : 0;
      lastEl = found.el;
      if (stableFor >= SETTLE) {
        window.clearInterval(timer);
        setActive(found);
      } else if (elapsed >= GIVE_UP) {
        window.clearInterval(timer);
      }
    }, STEP);

    return () => window.clearInterval(timer);
  }, [eligible, pathname, state.hints, active]);

  // Leaving the screen retires an un-dismissed hint rather than following the user.
  useEffect(() => {
    setActive(null);
  }, [pathname]);

  if (!active) return null;

  return (
    <HintBubble
      key={active.def.id}
      def={active.def}
      el={active.el}
      onDismiss={() => {
        dismissHint(active.def.id);
        setActive(null);
      }}
    />
  );
}

function HintBubble({ def, el, onDismiss }: { def: HintDef; el: HTMLElement; onDismiss: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [narrow] = useState(() => window.matchMedia('(max-width: 700px)').matches);

  useEffect(() => {
    const bubble = ref.current;
    if (!bubble || narrow) return;
    return autoUpdate(el, bubble, () => {
      computePosition(el, bubble, {
        strategy: 'fixed',
        placement: def.placement ?? 'bottom',
        middleware: [offset(10), flip({ padding: 12 }), shift({ padding: 12 })],
      }).then(({ x, y }) => setPos({ x, y }));
    });
  }, [el, def.placement, narrow]);

  // Escape dismisses, matching every other dismissible surface in the app. Capture
  // phase would be wrong here: a hint must not swallow Escape from a modal on top.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onDismiss();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  return createPortal(
    <div
      ref={ref}
      className={`hint-bubble${narrow ? ' hint-bubble--sheet' : ''}`}
      style={!narrow && pos ? { top: pos.y, left: pos.x } : undefined}
      // role="status" rather than a dialog: this is an unsolicited, non-modal message.
      // It is announced politely when it appears and it never steals focus - the page
      // the user chose to be on stays the thing they are interacting with.
      role="status"
      aria-live="polite"
      data-testid="hint-bubble"
      data-hint-id={def.id}
    >
      <div className="hint-bubble__head">
        <span className="hint-bubble__icon" aria-hidden="true">
          <Icon name="info" size={14} />
        </span>
        <p className="hint-bubble__title">{def.title}</p>
        <button type="button" className="hint-bubble__x" aria-label="Dismiss this tip" onClick={onDismiss}>
          <Icon name="x" size={13} />
        </button>
      </div>
      <p className="hint-bubble__body">{def.body}</p>
      <div className="hint-bubble__actions">
        <button type="button" className="tour-btn tour-btn--primary tour-btn--sm" onClick={onDismiss}>
          Got it
        </button>
      </div>
    </div>,
    document.body,
  );
}
