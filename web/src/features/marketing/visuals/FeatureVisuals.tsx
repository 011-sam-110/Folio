// Small purpose-built visuals for the feature cards. Each shows the actual mechanic the
// card describes rather than standing in for it with an icon: the slash menu lists the
// app's real blocks, the search bar parses the app's real operators, the review buttons
// are the four real SM-2 grades.
//
// Everything is drawn as SVG or set in the page's own typefaces. An earlier draft used
// Unicode symbols (❝ ⊞ ∑ ⌗, and superscripts for the integral) which fell out of the mono
// stack and were rendered by a fallback font at a different size and baseline - visibly
// mismatched, and on the card selling science degrees, mojibake.
//
// Each mock is a .mkt-demo: a scene that plays once, when it scrolls into view. The order
// is set with --step rather than by source position, and typing is done by clipping width
// rather than by rewriting text, so the finished sentence is always in the DOM. See the
// scroll-motion block in marketing.css - none of it applies unless motion is allowed.
//
// All are decorative: the card's heading and body carry the meaning for a screen reader,
// so each root is aria-hidden.
import PencilSketch from './PencilSketch';

/** Typing durations, sized to the line so the caret moves at a plausible speed. */
const TYPE_LINE = { '--type-steps': 26, '--type-dur': '780ms' } as React.CSSProperties;
const TYPE_SHORT = { '--type-steps': 20, '--type-dur': '620ms' } as React.CSSProperties;
const TYPE_QUERY = { '--type-steps': 52, '--type-dur': '1100ms' } as React.CSSProperties;

const step = (n: number) => ({ '--step': n }) as React.CSSProperties;

/** One stroke weight, one style, for every icon in these mocks. */
function VizIcon({ d }: { d: string }) {
  return (
    <svg className="mkt-viz__icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const BLOCKS = [
  { icon: 'M3 3h10v7H7l-3 3v-3H3V3Z', label: 'Callout', hint: 'Aside' },
  { icon: 'M2.5 3.5h11v9h-11v-9ZM2.5 7h11M6.5 3.5v9', label: 'Table', hint: 'Grid' },
  { icon: 'M12 3H4l4 5-4 5h8', label: 'Equation', hint: 'LaTeX' },
  { icon: 'M6 4 2.5 8 6 12M10 4l3.5 4L10 12', label: 'Code block', hint: 'Syntax' },
  { icon: 'M3.5 4.5h9M3.5 8h9M3.5 11.5h6', label: 'Quote', hint: 'Cited' },
];

export function WriteVisual() {
  return (
    <div className="mkt-viz mkt-viz--write mkt-demo" aria-hidden="true">
      <div className="mkt-viz__line">
        <span className="mkt-demo__type" style={TYPE_LINE}>
          Turn this into a callout <span className="mkt-viz__caret">/</span>
        </span>
      </div>
      <div className="mkt-viz__menu">
        {BLOCKS.map((row, i) => (
          <div
            key={row.label}
            className={`mkt-viz__row mkt-demo__step${i === 0 ? ' is-active' : ''}`}
            style={step(i + 7)}
          >
            <span className="mkt-viz__row-icon">
              <VizIcon d={row.icon} />
            </span>
            <span className="mkt-viz__row-label">{row.label}</span>
            <span className="mkt-viz__row-hint">{row.hint}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const BACKLINKS = ['Vertex Cover', 'NP-completeness', 'Reductions - week 7'];

export function LinkVisual() {
  return (
    <div className="mkt-viz mkt-viz--link mkt-demo" aria-hidden="true">
      <div className="mkt-viz__note">
        <span className="mkt-demo__type" style={TYPE_SHORT}>
          Reduces to <span className="mkt-viz__wiki">[[3-SAT]]</span>
        </span>
      </div>
      {/* fill is set on the dot only. Filling the <svg> overrode the path's own
          fill="none" and the open curve rendered as a smudge with the dashes swallowed. */}
      <svg className="mkt-viz__wire" viewBox="0 0 200 44" aria-hidden="true">
        <path d="M28 8 C 28 30, 120 18, 164 34" strokeDasharray="3 4" />
        <path d="M164 34 L 157 30.5 M164 34 L 157.5 39" />
        <circle cx="28" cy="8" r="2.6" className="mkt-viz__wire-dot" />
      </svg>
      <div className="mkt-viz__backlinks">
        <span className="mkt-viz__backlinks-head mkt-demo__step" style={step(6)}>
          Linked from 3 notes
        </span>
        {BACKLINKS.map((name, i) => (
          <span key={name} className="mkt-demo__step" style={step(i + 7)}>
            {name}
          </span>
        ))}
      </div>
    </div>
  );
}

const GRADES = ['Again', 'Hard', 'Good', 'Easy'];

export function StudyVisual() {
  return (
    <div className="mkt-viz mkt-viz--study mkt-demo" aria-hidden="true">
      <div className="mkt-viz__deck">
        <div className="mkt-viz__card mkt-viz__card--back" />
        <div className="mkt-viz__card mkt-viz__card--mid" />
        <div className="mkt-viz__card mkt-viz__card--front">
          <span className="mkt-viz__card-tag">Algorithms</span>
          <p className="mkt-viz__card-q">What is the time complexity of BFS?</p>
        </div>
      </div>
      {/* "Good" is pressed and the interval only then appears, which is the mechanic the
          card claims: the grade you give decides when the card comes back. */}
      <div className="mkt-viz__grades">
        {GRADES.map((g, i) => (
          <span
            key={g}
            className={`mkt-viz__grade mkt-demo__step${g === 'Good' ? ' is-good mkt-demo__press' : ''}`}
            style={{ '--step': i + 4, '--press-delay': '1500ms' } as React.CSSProperties}
          >
            {g}
          </span>
        ))}
      </div>
      <p className="mkt-viz__due mkt-demo__step" style={step(13)}>
        Next review in 4 days
      </p>
    </div>
  );
}

/** A miniature slide: title rule, two bullet rules, a diagram block. The first draft used
 *  three empty boxes, which read as image-loading skeletons directly beneath the claim
 *  that a lecture recording becomes slides. */
function MiniSlide({ at }: { at: number }) {
  return (
    <span className="mkt-viz__slide mkt-demo__step" style={step(at)}>
      <svg viewBox="0 0 44 28" aria-hidden="true">
        <path d="M4 6h22M4 12h14M4 17h17" />
        <rect x="27" y="10" width="13" height="12" rx="1.5" className="mkt-viz__slide-fill" />
      </svg>
    </span>
  );
}

export function CaptureVisual() {
  return (
    <div className="mkt-viz mkt-viz--capture mkt-demo" aria-hidden="true">
      <div className="mkt-viz__file mkt-demo__step" style={step(0)}>
        <span className="mkt-viz__file-kind">MP4</span>
        <span className="mkt-viz__file-name">lecture-04.mp4</span>
      </div>
      <div className="mkt-viz__arrow mkt-demo__step" style={step(3)}>
        <VizIcon d="M8 3v10M4 9.5l4 4 4-4" />
      </div>
      <div className="mkt-viz__slides">
        {[0, 1, 2].map((i) => (
          <MiniSlide key={i} at={i + 5} />
        ))}
      </div>
      <div className="mkt-viz__transcript mkt-demo__step" style={step(9)}>
        <span className="mkt-viz__stamp">12:04</span> so the invariant holds at every level…
      </div>
    </div>
  );
}

export function CanvasVisual() {
  // PencilSketch runs its own observer, because the stroke and the pencil riding it share
  // one timeline that the generic step sequencer cannot express.
  return (
    <div className="mkt-viz mkt-viz--canvas" aria-hidden="true">
      <PencilSketch />
      <p className="mkt-viz__caption">Pressure-sensitive · palm rejection</p>
    </div>
  );
}

const HITS = [
  'Breadth-First Search',
  'Deadlock avoidance',
  'Page replacement',
  'Scheduling - week 3',
];

export function FindVisual() {
  return (
    <div className="mkt-viz mkt-viz--find mkt-demo" aria-hidden="true">
      <div className="mkt-viz__query">
        <span className="mkt-demo__type" style={TYPE_QUERY}>
          <span className="mkt-viz__op">tag:</span>algorithms{' '}
          <span className="mkt-viz__op">notebook:</span>&quot;Operating Systems&quot;{' '}
          <span className="mkt-viz__op">-</span>revision
        </span>
      </div>
      <div className="mkt-viz__hits">
        {HITS.map((hit, i) => (
          <span key={hit} className="mkt-viz__hit mkt-demo__step" style={step(i + 9)}>
            {hit}
          </span>
        ))}
      </div>
    </div>
  );
}

export function NotationVisual() {
  // The three tiles are the three things the card's copy now names. When the copy dropped
  // the rotatable 3D model, the tile showing one had to go with it, or the card would be
  // illustrating a claim it no longer makes.
  return (
    <div className="mkt-viz mkt-viz--notation mkt-demo" aria-hidden="true">
      <div className="mkt-viz__tiles">
        <span className="mkt-viz__tile mkt-demo__step" style={step(0)}>
          {/* a real benzene ring with a hydroxyl, not an abstract polyline */}
          <svg viewBox="0 0 32 28" aria-hidden="true">
            <path d="M11 6.5 L19 6.5 L23 13.5 L19 20.5 L11 20.5 L7 13.5 Z" />
            <path d="M12.4 9 L17.6 9 M20.4 13.5 L17.9 17.9 M12.1 17.9 L9.6 13.5" />
            <path d="M23 13.5 L28 13.5" />
          </svg>
          Chemistry
        </span>
        <span className="mkt-viz__tile mkt-demo__step" style={step(3)}>
          <span className="mkt-viz__math">
            ∫<sub>0</sub>
            <sup>∞</sup> e<sup>-x²</sup> dx
          </span>
        </span>
        <span className="mkt-viz__tile mkt-demo__step" style={step(6)}>
          <span className="mkt-viz__code">
            <span className="mkt-viz__code-kw">def</span> bfs(g, root):
          </span>
        </span>
      </div>
    </div>
  );
}
