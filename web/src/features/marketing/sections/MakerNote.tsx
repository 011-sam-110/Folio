// This slot used to hold four testimonials. They were fabricated - invented students,
// invented degrees, real universities - disclosed only by a small "Sample" tag, and a
// design review was blunt about the cost: a reader who misses the tag is being misled,
// and a reader who catches it discounts every other claim on the page, including the
// true ones. Four labelled fakes are worth less than nothing.
//
// So the section says the one thing about this product that is both unusual and
// verifiable: who built it and why. When real, consented student quotes exist, they can
// go back in alongside this - not instead of it.
//
// The two paragraphs are Sam's own words from the v2 design, kept in his voice. Two
// changes were made to them and both need his sign-off: the product is called Unote
// throughout (the design said "Folio", which is the repository name and appears nowhere
// in the interface), and two grammatical slips were corrected. Nothing else was touched.
const FACTS = [
  {
    title: 'Free, and not the kind that expires',
    body: 'There is no trial clock and no paid tier holding a feature back. It stays free because it costs very little to run.',
  },
  {
    title: 'Your notes leave whenever you want',
    body: 'Every note exports as Markdown: plain text you can open in any other editor, with nothing to unpick and no export fee.',
  },
  {
    title: 'Still being built',
    body: 'Written alongside a degree, in the open, by someone using it for their own coursework. Bugs get fixed because they get hit.',
  },
];

export default function MakerNote() {
  return (
    <section className="mkt-maker" id="maker">
      <div className="mkt-maker__inner">
        <div className="mkt-maker__copy mkt-reveal">
          <p className="mkt-eyebrow">Who made this</p>
          <h2 className="mkt-section-title mkt-maker__title">Built by a student who needed it.</h2>
          <p className="mkt-maker__body">
            I am a second-year computer science student. Since university started I have been
            bouncing around note-taking apps, and have not been able to find a single one that
            suffices for my needs. That is when I decided to build Unote, a tool my friends and I
            have now used throughout first year. I write on paper in lectures and put my primary
            focus on the spoken content, then upload my paper notes and revise them against the
            uploaded lecture. It is easy to embed images, write complex maths equations and
            organise notes. Unote also helps me digest the content I have notes on with
            automatically generated flashcards, which have proven helpful for exams.
          </p>
          <p className="mkt-maker__body">
            After a few requests from friends I decided to share it in the most free way possible,
            which was a big part of the architectural design. That is why Unote is free, and why
            the AI features allow a personal API key.
          </p>
        </div>

        <ul className="mkt-maker__facts">
          {FACTS.map((f, i) => (
            <li key={f.title} className="mkt-maker__fact mkt-reveal" data-reveal-delay={i * 70}>
              <h3 className="mkt-maker__fact-title">{f.title}</h3>
              <p className="mkt-maker__fact-body">{f.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
