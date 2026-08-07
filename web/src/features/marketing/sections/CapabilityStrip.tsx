// Where a reference site would run a customer-logo bar, Unote runs the six things it
// replaces. Unote has no customer logos to show, and inventing them is the one thing a
// landing page must never do - so this states the breadth claim honestly instead.
//
// The strike is drawn rather than set as text-decoration, because it is struck ON as the
// row scrolls in: six lines crossing out six apps is the argument, and a decoration
// cannot be animated. The section's own label carries the meaning for anyone who never
// sees the marks.
const REPLACES = [
  'Lecture notes',
  'Flashcard decks',
  'Whiteboards',
  'Recordings',
  'PDF scribbles',
  'Revision folders',
];

export default function CapabilityStrip() {
  return (
    <section className="mkt-strip" aria-label="What Unote replaces">
      <div className="mkt-strip__inner mkt-reveal">
        <p className="mkt-strip__lead">One app instead of</p>
        <ul className="mkt-strip__list">
          {REPLACES.map((item, i) => (
            <li key={item} className="mkt-strip__item">
              {item}
              <span
                className="mkt-strip__strike"
                style={{ '--strike': i } as React.CSSProperties}
                aria-hidden="true"
              />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
