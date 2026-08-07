// The hero states the thesis: everything a degree generates, in one place.
//
// The signature element is the highlighter swipe under "degree" - a hand-drawn stroke
// rather than a rounded pill, because a highlighter is the actual instrument of the
// audience's world. It sweeps on once at load and then rests; it never loops.
import { Link } from 'react-router-dom';
import ProductShot from './ProductShot';

export default function Hero() {
  return (
    <section className="mkt-hero">
      {/* Ambient layer. Two very slow, very faint gradients breathing out of phase, so the
          paper reads as lit by something rather than as a flat fill. It is deliberately
          almost subliminal: anything you can consciously watch on a hero becomes a thing
          competing with the headline. */}
      <div className="mkt-hero__ambience" aria-hidden="true">
        <span className="mkt-hero__lamp" />
        <span className="mkt-hero__lamp mkt-hero__lamp--2" />
      </div>

      <div className="mkt-hero__inner">
        <p className="mkt-eyebrow mkt-reveal">Built for university students</p>

        <h1 className="mkt-hero__title mkt-reveal" data-reveal-delay="70">
          Where your whole{' '}
          <span className="mkt-mark">
            <span className="mkt-mark__word">degree</span>
            <Highlighter />
          </span>{' '}
          comes together.
        </h1>

        <p className="mkt-hero__lede mkt-reveal" data-reveal-delay="140">
          Lecture notes, recordings, flashcards and boards in one place, with optional AI that only
          helps when you ask it to.
        </p>

        <div className="mkt-hero__cta mkt-reveal" data-reveal-delay="210">
          <Link className="mkt-btn mkt-btn--primary mkt-btn--lg" to="/signup">
            Start writing, it's free
          </Link>
          <a className="mkt-btn mkt-btn--quiet mkt-btn--lg" href="#features">
            See how it works
          </a>
        </div>

        {/* The lower-commitment door, kept out of the button row so it does not compete
            with the primary action. It opens the real editor rather than a demo, so the
            trade it makes is stated in the same breath. Carries v2's reveal like every
            other line in the hero - the door is part of the offer, not an afterthought
            bolted on after the animation finishes. */}
        <p className="mkt-hero__trust mkt-reveal" data-reveal-delay="260">
          Free to use. No card. Your notes stay yours. Or{' '}
          <Link className="mkt-hero__try" to="/try">
            try it without an account
          </Link>{' '}
          - everything stays in your browser and nothing is saved.
        </p>
      </div>

      <ProductShot />
    </section>
  );
}

/** The swipe itself. Two overlapping strokes with uneven, non-parallel edges, so it reads
 *  as something dragged across the page by hand rather than a rectangle with rounded
 *  corners. The ink deliberately fills the viewBox top to bottom: the element is then
 *  positioned once in CSS, instead of the offset being split between here and there. */
function Highlighter() {
  return (
    <svg className="mkt-mark__ink" viewBox="0 0 240 56" preserveAspectRatio="none" aria-hidden="true">
      <path d="M4 12 C 46 3, 96 18, 146 8 S 212 3, 236 11 L 234 48 C 196 40, 148 54, 100 46 S 30 50, 6 45 Z" />
      <path
        className="mkt-mark__ink-top"
        d="M8 29 C 52 23, 98 36, 150 27 S 208 23, 232 29 L 231 44 C 198 38, 148 51, 102 42 S 32 46, 7 41 Z"
      />
    </svg>
  );
}
