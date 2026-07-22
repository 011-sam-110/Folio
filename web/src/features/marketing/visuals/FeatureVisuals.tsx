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
// All are decorative: the card's heading and body carry the meaning for a screen reader,
// so each root is aria-hidden.
import PencilSketch from './PencilSketch';

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
    <div className="mkt-viz mkt-viz--write" aria-hidden="true">
      <div className="mkt-viz__line">
        Turn this into a callout <span className="mkt-viz__caret">/</span>
      </div>
      <div className="mkt-viz__menu">
        {BLOCKS.map((row, i) => (
          <div key={row.label} className={`mkt-viz__row${i === 0 ? ' is-active' : ''}`}>
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

export function LinkVisual() {
  return (
    <div className="mkt-viz mkt-viz--link" aria-hidden="true">
      <div className="mkt-viz__note">
        Reduces to <span className="mkt-viz__wiki">[[3-SAT]]</span>
      </div>
      {/* fill is set on the dot only. Filling the <svg> overrode the path's own
          fill="none" and the open curve rendered as a smudge with the dashes swallowed. */}
      <svg className="mkt-viz__wire" viewBox="0 0 200 44" aria-hidden="true">
        <path d="M28 8 C 28 30, 120 18, 164 34" strokeDasharray="3 4" />
        <path d="M164 34 L 157 30.5 M164 34 L 157.5 39" />
        <circle cx="28" cy="8" r="2.6" className="mkt-viz__wire-dot" />
      </svg>
      <div className="mkt-viz__backlinks">
        <span className="mkt-viz__backlinks-head">Linked from 3 notes</span>
        <span>Vertex Cover</span>
        <span>NP-completeness</span>
        <span>Reductions - week 7</span>
      </div>
    </div>
  );
}

export function StudyVisual() {
  return (
    <div className="mkt-viz mkt-viz--study" aria-hidden="true">
      <div className="mkt-viz__deck">
        <div className="mkt-viz__card mkt-viz__card--back" />
        <div className="mkt-viz__card mkt-viz__card--mid" />
        <div className="mkt-viz__card mkt-viz__card--front">
          <span className="mkt-viz__card-tag">Algorithms</span>
          <p className="mkt-viz__card-q">What is the time complexity of BFS?</p>
        </div>
      </div>
      <div className="mkt-viz__grades">
        <span className="mkt-viz__grade">Again</span>
        <span className="mkt-viz__grade">Hard</span>
        <span className="mkt-viz__grade is-good">Good</span>
        <span className="mkt-viz__grade">Easy</span>
      </div>
      <p className="mkt-viz__due">Next review in 4 days</p>
    </div>
  );
}

/** A miniature slide: title rule, two bullet rules, a diagram block. The first draft used
 *  three empty boxes, which read as image-loading skeletons directly beneath the claim
 *  that a lecture recording becomes slides. */
function MiniSlide() {
  return (
    <span className="mkt-viz__slide">
      <svg viewBox="0 0 44 28" aria-hidden="true">
        <path d="M4 6h22M4 12h14M4 17h17" />
        <rect x="27" y="10" width="13" height="12" rx="1.5" className="mkt-viz__slide-fill" />
      </svg>
    </span>
  );
}

export function CaptureVisual() {
  return (
    <div className="mkt-viz mkt-viz--capture" aria-hidden="true">
      <div className="mkt-viz__file">
        <span className="mkt-viz__file-kind">MP4</span>
        <span className="mkt-viz__file-name">lecture-04.mp4</span>
      </div>
      <div className="mkt-viz__arrow">
        <VizIcon d="M8 3v10M4 9.5l4 4 4-4" />
      </div>
      <div className="mkt-viz__slides">
        <MiniSlide />
        <MiniSlide />
        <MiniSlide />
      </div>
      <div className="mkt-viz__transcript">
        <span className="mkt-viz__stamp">12:04</span> so the invariant holds at every level…
      </div>
    </div>
  );
}

export function CanvasVisual() {
  return (
    <div className="mkt-viz mkt-viz--canvas" aria-hidden="true">
      <PencilSketch />
      <p className="mkt-viz__caption">Pressure-sensitive · palm rejection</p>
    </div>
  );
}

export function FindVisual() {
  return (
    <div className="mkt-viz mkt-viz--find" aria-hidden="true">
      <div className="mkt-viz__query">
        <span className="mkt-viz__op">tag:</span>algorithms{' '}
        <span className="mkt-viz__op">notebook:</span>&quot;Operating Systems&quot;{' '}
        <span className="mkt-viz__op">-</span>revision
      </div>
      <div className="mkt-viz__hits">
        <span className="mkt-viz__hit">Breadth-First Search</span>
        <span className="mkt-viz__hit">Deadlock avoidance</span>
        <span className="mkt-viz__hit">Page replacement</span>
        <span className="mkt-viz__hit">Scheduling - week 3</span>
      </div>
    </div>
  );
}

export function NotationVisual() {
  return (
    <div className="mkt-viz mkt-viz--notation" aria-hidden="true">
      <div className="mkt-viz__tiles">
        <span className="mkt-viz__tile">
          {/* a real benzene ring with a hydroxyl, not an abstract polyline */}
          <svg viewBox="0 0 32 28" aria-hidden="true">
            <path d="M11 6.5 L19 6.5 L23 13.5 L19 20.5 L11 20.5 L7 13.5 Z" />
            <path d="M12.4 9 L17.6 9 M20.4 13.5 L17.9 17.9 M12.1 17.9 L9.6 13.5" />
            <path d="M23 13.5 L28 13.5" />
          </svg>
          Chemistry
        </span>
        <span className="mkt-viz__tile">
          <span className="mkt-viz__math">
            ∫<sub>0</sub>
            <sup>∞</sup> e<sup>-x²</sup> dx
          </span>
        </span>
        <span className="mkt-viz__tile">
          <svg viewBox="0 0 32 28" aria-hidden="true">
            <path d="M16 4 L27 10 L27 19 L16 25 L5 19 L5 10 Z" />
            <path d="M16 4 L16 14.5 M5 10 L16 14.5 L27 10" />
          </svg>
          3D model
        </span>
      </div>
    </div>
  );
}
