// The AI section. The pitch is deliberately "optional": the product's argument is that it
// is a good notebook first, and that the AI is a tool you pick up rather than a thing that
// happens to your notes.
//
// The section head runs full width above both columns. Inside a 525px column the 46px
// heading wrapped to two lines when it fits comfortably on one across the full measure.
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
      <header className="mkt-ai__head">
        <p className="mkt-eyebrow mkt-eyebrow--on-dark">Optional AI</p>
        <h2 className="mkt-ai__title">AI that waits to be asked.</h2>
        <p className="mkt-ai__lede">
          Unote works entirely without it. Turn it on and it reads only the notes you point it at -
          nothing runs in the background, and nothing is rewritten unless you accept the change.
        </p>
      </header>

      <div className="mkt-ai__inner">
        <ul className="mkt-ai__list">
          {CAPABILITIES.map((c) => (
            <li key={c.title} className="mkt-ai__item">
              <h3 className="mkt-ai__item-title">{c.title}</h3>
              <p className="mkt-ai__item-body">{c.body}</p>
            </li>
          ))}
          <li className="mkt-ai__note-wrap">
            <p className="mkt-ai__note">
              Off by default. One switch in settings turns it on, and the same switch turns it off.
            </p>
          </li>
        </ul>

        <div className="mkt-ai__demo" aria-hidden="true">
          <div className="mkt-ai__prompt">
            <span className="mkt-ai__spark">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M8 2.2 9.5 6.5 13.8 8 9.5 9.5 8 13.8 6.5 9.5 2.2 8 6.5 6.5 8 2.2Z" />
              </svg>
            </span>
            Asking 47 notes in Algorithms
          </div>

          <div className="mkt-ai__scope">
            <span className="mkt-ai__scope-note">Breadth-First Search</span>
            <span className="mkt-ai__scope-note">Shortest Paths</span>
            <span className="mkt-ai__scope-note">Reductions</span>
            <span className="mkt-ai__scope-note">+44 more</span>
          </div>

          <p className="mkt-ai__question">Where did we prove BFS is optimal for unweighted graphs?</p>

          <div className="mkt-ai__answer">
            <p className="mkt-ai__answer-text">
              In <span className="mkt-ai__cite">Breadth-First Search</span>, week 4 - the level-order
              argument. It is used again in <span className="mkt-ai__cite">Shortest Paths</span> to
              motivate Dijkstra.
            </p>
            <div className="mkt-ai__sources">
              <span className="mkt-ai__source">Breadth-First Search</span>
              <span className="mkt-ai__source">Shortest Paths</span>
            </div>
          </div>

          <div className="mkt-ai__actions">
            <span className="mkt-ai__action">Insert into note</span>
            <span className="mkt-ai__action is-quiet">Discard</span>
          </div>
        </div>
      </div>
    </section>
  );
}
