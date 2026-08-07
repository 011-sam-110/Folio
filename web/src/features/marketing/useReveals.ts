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
//
// MOTION REPLAYS IN BOTH DIRECTIONS, which is what the design does and what Sam asked for.
// An element that leaves the viewport is re-hidden and animates again on the way back, and
// a mock resets and replays its whole scene. The earlier build revealed once and left
// everything alone, which made the page static on every scroll after the first.
//
// Two things keep that from becoming a liability, and both matter:
//   • Only ever inside `is-armed`. No JS, reduced motion, or a crawler and none of this
//     runs, so the page is never a screenful of invisible text for a reader who cannot
//     see the animation that would have filled it in.
//   • Hidden means `opacity: 0`, not `display: none` or removed text. The words stay in
//     the DOM and in the accessibility tree the whole time, so find-in-page still finds
//     them - and finding one scrolls it into view, which reveals it.
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

    // Per-element, so leaving mid-stagger cancels only that element's pending reveal. One
    // shared list would leave a timer from the previous pass to fire over the new one.
    const pending = new Map<HTMLElement, number>();
    const cancel = (el: HTMLElement) => {
      const t = pending.get(el);
      if (t !== undefined) {
        window.clearTimeout(t);
        pending.delete(el);
      }
    };

    const revealIo = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const el = entry.target as HTMLElement;
          if (entry.isIntersecting) {
            if (el.classList.contains('is-in') || pending.has(el)) continue;
            const delay = Number(el.dataset.revealDelay ?? 0);
            if (delay > 0) {
              pending.set(
                el,
                window.setTimeout(() => {
                  pending.delete(el);
                  el.classList.add('is-in');
                }, delay),
              );
            } else {
              el.classList.add('is-in');
            }
          } else {
            cancel(el);
            el.classList.remove('is-in');
          }
        }
      },
      { threshold: [0, 0.08], rootMargin: '0px 0px -40px 0px' },
    );
    reveals.forEach((el) => revealIo.observe(el));

    /**
     * Restart a mock's scene.
     *
     * The scenes are CSS animations keyed off `.is-playing`, and re-adding a class the
     * element already has does nothing at all. Removing it, forcing a reflow by reading a
     * layout property, and adding it back is what makes the browser treat it as a new
     * animation - without the read the two class changes coalesce into no change and the
     * scene never replays.
     */
    const play = (el: HTMLElement) => {
      el.classList.remove('is-playing');
      void el.offsetWidth;
      el.classList.add('is-playing');
    };

    // A mock only starts once a third of it is showing, so a sequence never plays out of
    // sight and finishes before the reader arrives at it. It resets on the way out so the
    // next approach gets the scene from the beginning rather than its final frame.
    const demoIo = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const el = entry.target as HTMLElement;
          if (entry.isIntersecting && entry.intersectionRatio >= 0.3) {
            if (!el.classList.contains('is-playing')) play(el);
          } else if (!entry.isIntersecting) {
            el.classList.remove('is-playing');
          }
        }
      },
      { threshold: [0, 0.3] },
    );
    demos.forEach((el) => demoIo.observe(el));

    // Last resort, and first load only. If an observer is throttled, mis-measures a lazily
    // sized element, or simply never reports, this shows what is already on screen: the
    // page can be late but it can never be blank. Deliberately NOT a blanket reveal of
    // everything - with replay on, that would fight the observer for anything below the
    // fold, revealing it and then having it hidden again the moment the observer caught up.
    const safety = window.setTimeout(() => {
      for (const el of reveals) {
        if (el.classList.contains('is-in')) continue;
        const box = el.getBoundingClientRect();
        if (box.top < window.innerHeight && box.bottom > 0) el.classList.add('is-in');
      }
      for (const el of demos) {
        if (el.classList.contains('is-playing')) continue;
        const box = el.getBoundingClientRect();
        if (box.top < window.innerHeight && box.bottom > 0) play(el);
      }
    }, 1800);

    return () => {
      revealIo.disconnect();
      demoIo.disconnect();
      window.clearTimeout(safety);
      pending.forEach((t) => window.clearTimeout(t));
    };
  }, [armed, rootRef]);

  return armed;
}
