// The AI section. The pitch is deliberately "optional": the product's argument is that it
// is a good notebook first, and that the AI is a tool you pick up rather than a thing that
// happens to your notes.
//
// The heading sits inside the left column with the argument it introduces, rather than
// running full width above both. That was tried the other way and a 46px heading wrapped
// badly in a 525px column, so the title takes its own smaller clamp here (see
// .mkt-ai__title) instead of the page's shared h2 step.
const CAPABILITIES = [
  {
    title: 'Ask across your notes',
    body: 'Put a question to everything you have written this term and get an answer that cites the notes it came from.',
  },
  {
    title: 'Summarise what you highlighted',
    body: 'Turn three pages of lecture notes into the six lines you will actually revise from.',
  },
  {
    title: 'Draft the flashcards',
    body: 'Hand it a passage and get question-and-answer pairs back, which you edit before any of them enter your deck.',
  },
];

export default function AiBand() {
  return (
    <section className="mkt-ai" id="ai">
      <p className="mkt-eyebrow mkt-eyebrow--on-dark mkt-ai__eyebrow mkt-reveal">Optional AI</p>

      <div className="mkt-ai__inner">
        <div className="mkt-ai__copy">
          <h2 className="mkt-ai__title mkt-reveal">AI that waits to be asked.</h2>
          <p className="mkt-ai__lede mkt-reveal" data-reveal-delay="80">
            Unote works entirely without it. Turn it on and it reads only the notes you point it at.
            Nothing runs in the background, and nothing is rewritten unless you accept the change.
          </p>

          <ul className="mkt-ai__list">
            {CAPABILITIES.map((c, i) => (
              <li key={c.title} className="mkt-ai__item mkt-reveal" data-reveal-delay={i * 70}>
                <h3 className="mkt-ai__item-title">{c.title}</h3>
                <p className="mkt-ai__item-body">{c.body}</p>
              </li>
            ))}
          </ul>

          <p className="mkt-ai__note mkt-reveal" data-reveal-delay="200">
            Off by default. One switch in settings turns it on, and the same switch turns it off.
          </p>
        </div>

        <div className="mkt-ai__demo mkt-demo mkt-reveal" data-reveal-delay="120" aria-hidden="true">
          <div className="mkt-ai__prompt">
            <span className="mkt-ai__spark">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M8 2.2 9.5 6.5 13.8 8 9.5 9.5 8 13.8 6.5 9.5 2.2 8 6.5 6.5 8 2.2Z" />
              </svg>
            </span>
            Asking 47 notes in Algorithms
          </div>

          <div className="mkt-ai__scope">
            {['Breadth-First Search', 'Shortest Paths', 'Reductions', '+44 more'].map((n, i) => (
              <span
                key={n}
                className={`mkt-ai__scope-note mkt-demo__step${n.startsWith('+') ? ' is-rest' : ''}`}
                style={{ '--step': i } as React.CSSProperties}
              >
                {n}
              </span>
            ))}
          </div>

          <p className="mkt-ai__question">
            <span
              className="mkt-demo__type"
              style={{ '--type-steps': 56, '--type-dur': '1200ms', '--type-delay': '600ms' } as React.CSSProperties}
            >
              Where did we prove BFS is optimal for unweighted graphs?
            </span>
          </p>

          <div className="mkt-ai__answer mkt-demo__step" style={{ '--step': 14 } as React.CSSProperties}>
            <p className="mkt-ai__answer-text">
              In <span className="mkt-ai__cite">Breadth-First Search</span>, week 4, the level-order
              argument. It is used again in <span className="mkt-ai__cite">Shortest Paths</span> to
              motivate Dijkstra.
            </p>
            <div className="mkt-ai__sources">
              <span className="mkt-ai__source">Breadth-First Search</span>
              <span className="mkt-ai__source">Shortest Paths</span>
            </div>
          </div>

          <div className="mkt-ai__actions mkt-demo__step" style={{ '--step': 17 } as React.CSSProperties}>
            <span className="mkt-ai__action">Insert into note</span>
            <span className="mkt-ai__action is-quiet">Discard</span>
          </div>
        </div>
      </div>
    </section>
  );
}
