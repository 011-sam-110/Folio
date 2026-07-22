// Where a reference site would run a customer-logo bar, Unote runs the six things it
// replaces. Unote has no customer logos to show, and inventing them is the one thing a
// landing page must never do - so this states the breadth claim honestly instead.
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
      <p className="mkt-strip__lead">One app instead of</p>
      <ul className="mkt-strip__list">
        {REPLACES.map((item) => (
          <li key={item} className="mkt-strip__item">
            {item}
          </li>
        ))}
      </ul>
    </section>
  );
}
