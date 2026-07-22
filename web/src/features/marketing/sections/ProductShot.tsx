// A replica of the real Unote editor, built in DOM rather than shipped as a screenshot:
// it stays sharp at any density, reflows on a phone, weighs nothing, and can act out the
// product's core loop instead of describing it.
//
// That loop is the point. A line is typed, a passage is highlighted, the selection
// toolbar offers "Make flashcard", and the card appears - write, then study, which is the
// whole argument for the product.
//
// Two rules the first draft got wrong and a design review caught:
//  1. The FINISHED state is the default. Everything here renders complete with no CSS
//     applied; the animation is an enhancement layered on top for wide screens with
//     motion allowed. A visitor who arrives mid-sequence, resizes, or scrolls past in
//     three seconds still sees the whole argument.
//  2. The selection toolbar does not animate away. It is the frame that explains where
//     the flashcard came from, so removing it after a beat deleted the thesis. It now
//     appears and stays.
import Wordmark from '../Wordmark';

const NAV = [
  { key: 'home', label: 'Home' },
  { key: 'study', label: 'Study' },
  { key: 'ask', label: 'Ask AI' },
  { key: 'search', label: 'Search' },
];

const NOTEBOOKS = [
  { name: 'Algorithms', count: 12, tone: 'a', active: true },
  { name: 'Operating Systems', count: 9, tone: 'b' },
  { name: 'Discrete Maths', count: 7, tone: 'c' },
];

export default function ProductShot() {
  return (
    <div
      className="mkt-shot"
      role="img"
      aria-label="The Unote editor: a note titled Breadth-First Search, tagged algorithms and week 4, with a highlighted passage being turned into a flashcard."
    >
      <div className="mkt-shot__frame">
        <div className="mkt-shot__chrome" aria-hidden="true">
          <span className="mkt-shot__dot" />
          <span className="mkt-shot__dot" />
          <span className="mkt-shot__dot" />
          <span className="mkt-shot__url">unote.app/note/breadth-first-search</span>
        </div>

        <div className="mkt-shot__body" aria-hidden="true">
          <aside className="mkt-shot__sidebar">
            <div className="mkt-shot__brand">
              <Wordmark size={15} />
              <strong>Unote</strong>
            </div>
            <div className="mkt-shot__search">
              <ShotIcon name="search" />
              Search
            </div>
            {NAV.map((item) => (
              <div key={item.key} className="mkt-shot__nav">
                <ShotIcon name={item.key} />
                {item.label}
              </div>
            ))}
            <div className="mkt-shot__label">Notebooks</div>
            {NOTEBOOKS.map((nb) => (
              <div key={nb.name} className={`mkt-shot__nav${nb.active ? ' is-active' : ''}`}>
                <span className={`mkt-shot__swatch mkt-shot__swatch--${nb.tone}`} />
                {nb.name}
                <span className="mkt-shot__count">{nb.count}</span>
              </div>
            ))}
          </aside>

          <div className="mkt-shot__doc">
            <div className="mkt-shot__crumbs">Algorithms › Breadth-First Search</div>
            <h3 className="mkt-shot__title">Breadth-First Search</h3>
            <div className="mkt-shot__tags">
              <span className="mkt-shot__tag">#algorithms</span>
              <span className="mkt-shot__tag">#week4</span>
            </div>

            <p className="mkt-shot__para">
              <span className="mkt-shot__typed">
                BFS explores a graph one level at a time, using a queue.
              </span>
            </p>

            <p className="mkt-shot__para mkt-shot__para--2">
              It visits every node at depth <em>d</em> before any node at depth <em>d</em>+1, which
              is why it finds the{' '}
              <span className="mkt-shot__hl">shortest path in an unweighted graph</span>. Compare
              with <span className="mkt-shot__wikilink">[[Dijkstra]]</span>.

              {/* Anchored to the paragraph it belongs to, not to the frame - the passage
                  moves with the text at every width, and so must the toolbar. */}
              <span className="mkt-shot__toolbar">
                <span className="mkt-shot__toolbar-b">B</span>
                <span className="mkt-shot__toolbar-i">I</span>
                <span className="mkt-shot__toolbar-pen">
                  <ShotIcon name="pen" />
                </span>
                <span className="mkt-shot__toolbar-sep" />
                <span className="mkt-shot__toolbar-cta">
                  <ShotIcon name="spark" />
                  Make flashcard
                </span>
              </span>
            </p>

            <div className="mkt-shot__card">
              <div className="mkt-shot__card-head">
                <span className="mkt-shot__card-badge">New flashcard</span>
                <span className="mkt-shot__card-due">Due today</span>
              </div>
              <p className="mkt-shot__card-q">
                Why does BFS find the shortest path in an unweighted graph?
              </p>
              <p className="mkt-shot__card-a">
                It visits every node at depth d before any node at depth d+1.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="mkt-shot__glow" aria-hidden="true" />
    </div>
  );
}

/** Stroke icons at a single weight, replacing the Unicode glyphs the first draft used -
 *  those fell out of the mono stack and rendered from a fallback at a different size and
 *  baseline, which was visible as mismatched sidebar icons. */
function ShotIcon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    search: (
      <>
        <circle cx="7" cy="7" r="4.5" />
        <path d="M10.4 10.4 14 14" />
      </>
    ),
    home: <path d="M2.5 7 8 2.5 13.5 7v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V7Z" />,
    study: <path d="M8 2.5 13.5 8 8 13.5 2.5 8 8 2.5Z" />,
    ask: <path d="M8 2.2 9.5 6.5 13.8 8 9.5 9.5 8 13.8 6.5 9.5 2.2 8 6.5 6.5 8 2.2Z" />,
    pen: <path d="M11.5 2.5 13.5 4.5 5 13H3v-2l8.5-8.5Z" />,
    spark: <path d="M8 2.2 9.5 6.5 13.8 8 9.5 9.5 8 13.8 6.5 9.5 2.2 8 6.5 6.5 8 2.2Z" />,
  };
  return (
    <svg className="mkt-shot__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      {paths[name] ?? paths.home}
    </svg>
  );
}
