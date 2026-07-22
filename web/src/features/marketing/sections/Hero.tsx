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
        <p className="mkt-eyebrow">Built for university students</p>

        <h1 className="mkt-hero__title">
          Where your whole{' '}
          <span className="mkt-mark">
            <span className="mkt-mark__word">degree</span>
            <Highlighter />
          </span>{' '}
          comes together.
        </h1>

        <p className="mkt-hero__lede">
          Lecture notes, recordings, flashcards and boards in one place - with optional AI that only
          helps when you ask it to.
        </p>

        <div className="mkt-hero__cta">
          <Link className="mkt-btn mkt-btn--primary mkt-btn--lg" to="/signup">
            Start writing - it's free
          </Link>
          <a className="mkt-btn mkt-btn--quiet mkt-btn--lg" href="#features">
            See how it works
          </a>
        </div>

        <p className="mkt-hero__trust">Free to use. No card. Your notes stay yours.</p>
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
