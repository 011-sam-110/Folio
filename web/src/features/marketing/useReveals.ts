// Scroll-in motion for the landing page.
//
// The rule this follows is the one the product shot already established: the FINISHED
// state is what the markup renders. Nothing here is hidden by CSS alone - the page is
// fully visible with JavaScript disabled, with an observer that never fires, to a crawler,
// and to a screenshot taken before any of this runs. Elements are only emptied once this
// hook has committed to animating them, which it signals by putting .is-armed on the root
// before first paint.
//
// That ordering is why arming happens in useLayoutEffect and the observer in useEffect:
// the class lands in the same frame as the first paint, so there is no flash of the
// finished state followed by it disappearing.
import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';

/** Everything that scrolls in carries this; a numeric data-reveal-delay staggers siblings. */
const REVEAL = '.mkt-reveal';
/** A self-contained mock that plays its own little sequence when it comes into view. */
const DEMO = '.mkt-demo';

export default function useReveals(rootRef: RefObject<HTMLElement | null>): boolean {
  const [armed, setArmed] = useState(false);

  useLayoutEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    setArmed(true);
  }, []);

  useEffect(() => {
    if (!armed) return;
    const root = rootRef.current;
    if (!root) return;

    const reveals = Array.from(root.querySelectorAll<HTMLElement>(REVEAL));
    const demos = Array.from(root.querySelectorAll<HTMLElement>(DEMO));
    const timers: number[] = [];

    // Revealed once and then left alone. The design file re-hides each element every time
    // it leaves the viewport, which means content is missing whenever it is off screen and
    // animates again on the way back up. On a page people scroll in both directions that
    // reads as a fault, and it puts find-in-page against hidden text.
    const revealIo = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const el = entry.target as HTMLElement;
          revealIo.unobserve(el);
          const delay = Number(el.dataset.revealDelay ?? 0);
          if (delay > 0) timers.push(window.setTimeout(() => el.classList.add('is-in'), delay));
          else el.classList.add('is-in');
        }
      },
      { threshold: 0.08, rootMargin: '0px 0px -40px 0px' },
    );
    reveals.forEach((el) => revealIo.observe(el));

    // A mock only starts once a third of it is showing, so a sequence never plays out of
    // sight and finish before the reader arrives at it.
    const demoIo = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.intersectionRatio < 0.3) continue;
          const el = entry.target as HTMLElement;
          demoIo.unobserve(el);
          el.classList.add('is-playing');
        }
      },
      { threshold: [0, 0.3] },
    );
    demos.forEach((el) => demoIo.observe(el));

    // Last resort. If an observer is throttled, mis-measures a lazily sized element, or
    // simply never reports, this shows everything anyway: the page can be late but it can
    // never be blank.
    timers.push(
      window.setTimeout(() => {
        reveals.forEach((el) => el.classList.add('is-in'));
        demos.forEach((el) => el.classList.add('is-playing'));
      }, 2600),
    );

    return () => {
      revealIo.disconnect();
      demoIo.disconnect();
      timers.forEach(window.clearTimeout);
    };
  }, [armed, rootRef]);

  return armed;
}
