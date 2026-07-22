// A pencil that draws, in the one place on the page where drawing is the subject.
//
// Two things make it read as real rather than as a line animation:
//
//  1. The stroke is a FILLED outline, not a stroked path, so it can vary in width the way
//     a pressure-sensitive stylus does - thin on the fast entry, swelling through the
//     turns, tapering out. A constant-width stroke is exactly the thing that would
//     disprove the "pressure-sensitive" caption printed under it.
//  2. Because the mark is filled, it cannot be revealed with stroke-dashoffset. It is
//     revealed by wiping a clip rect across it instead, and the pencil rides the same
//     timeline along the centreline via offset-path - so tip and mark stay together.
//
// It draws once when scrolled into view, then rests as a finished sketch. Under
// prefers-reduced-motion the finished sketch is simply there (see marketing.css).
import { useLayoutEffect, useRef, useState } from 'react';

// The centreline the pencil tip follows. Kept identical in shape to the spine of the
// filled mark below, or the tip drifts off its own stroke.
const CENTRELINE = 'M14 62 C 30 34, 44 30, 56 48 S 76 78, 92 58 S 118 26, 140 44 S 168 66, 182 40';

export default function PencilSketch() {
  const ref = useRef<HTMLDivElement>(null);
  // Two flags, not one. `armed` is what empties the sketch, and it is only ever set once
  // this effect has confirmed it can actually animate - so if the observer never fires,
  // or the browser has none, or the visitor asked for reduced motion, the card shows a
  // finished drawing instead of an empty box. Blanking first and hoping the animation
  // arrives is how an element ends up permanently invisible.
  const [armed, setArmed] = useState(false);
  const [drawn, setDrawn] = useState(false);

  // Layout effect so arming happens before the browser paints: armed then immediately
  // drawn would otherwise flash the finished sketch for one frame.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    setArmed(true);
    // Starts on entry rather than on load: the card is well below the fold, and an
    // animation that finished before you scrolled to it may as well not have run.
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setDrawn(true);
          io.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      className={`mkt-sketch${armed ? ' is-armed' : ''}${drawn ? ' is-drawn' : ''}`}
      ref={ref}
      aria-hidden="true"
    >
      <svg viewBox="0 0 200 108" fill="none">
        <defs>
          <clipPath id="mkt-sketch-wipe">
            {/* Swept left to right in CSS; this is what reveals the filled mark. */}
            <rect className="mkt-sketch__wipe" x="0" y="0" width="200" height="108" />
          </clipPath>
        </defs>

        {/* the board underneath - what is being annotated */}
        <rect x="10" y="12" width="52" height="32" rx="4" className="mkt-sketch__sticky" />
        <rect x="126" y="60" width="60" height="34" rx="4" className="mkt-sketch__sticky mkt-sketch__sticky--2" />
        <path className="mkt-sketch__conn" d="M62 28 C 92 28, 96 74, 126 76" strokeDasharray="4 4" />

        {/* the pencil mark itself: one closed outline whose two edges are not parallel,
            so the mark is thin at the ends and heavy through the middle of each turn */}
        <g clipPath="url(#mkt-sketch-wipe)">
          <path
            className="mkt-sketch__ink"
            d="M14 62.6 C 30 34.6, 44.4 30.4, 56 47.2 S 76 77, 92 57 S 118 25, 140 42.6 S 168 64.6, 182 39.4
               L 182 41.2 C 168 67.4, 140.6 46.4, 140 47.4 S 118 30.6, 92.6 61 S 75.4 82.6, 55.4 51
               S 30.6 39.4, 15.4 63.4 Z"
          />
        </g>

        {/* the pencil, riding the same centreline */}
        <g className="mkt-sketch__pencil">
          <path d="M0 0 L7 2.2 L28 -3.4 L27 -8.6 L6.4 -5.2 Z" className="mkt-sketch__pencil-body" />
          <path d="M0 0 L7 2.2 L6.4 -5.2 Z" className="mkt-sketch__pencil-tip" />
          <path d="M25.6 -8.2 L27.2 -8.6 L28.2 -3.4 L26.6 -3 Z" className="mkt-sketch__pencil-end" />
        </g>
      </svg>

      {/* offset-path cannot be set from an attribute, so the centreline is handed to CSS
          as a custom property and consumed by .mkt-sketch__pencil. */}
      <style>{`.mkt-sketch { --mkt-sketch-path: path('${CENTRELINE}'); }`}</style>
    </div>
  );
}
