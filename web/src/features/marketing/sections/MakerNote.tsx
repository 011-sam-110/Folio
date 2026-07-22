// This slot used to hold four testimonials. They were fabricated - invented students,
// invented degrees, real universities - disclosed only by a small "Sample" tag, and a
// design review was blunt about the cost: a reader who misses the tag is being misled,
// and a reader who catches it discounts every other claim on the page, including the
// true ones. Four labelled fakes are worth less than nothing.
//
// So the section now says the one thing about this product that is both unusual and
// verifiable: who built it and why. When real, consented student quotes exist, they can
// go back in alongside this - not instead of it.
const FACTS = [
  {
    title: 'Free, and not the kind that expires',
    body: 'There is no trial clock and no paid tier holding a feature back. It stays free because it costs very little to run.',
  },
  {
    title: 'Your notes leave whenever you want',
    body: 'Every note exports as Markdown - plain text you can open in any other editor, with nothing to unpick and no export fee.',
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
        <div className="mkt-maker__copy">
          <p className="mkt-eyebrow">Who made this</p>
          <h2 className="mkt-section-title mkt-maker__title">Built by a student who needed it.</h2>
          <p className="mkt-maker__body">
            I am a second-year computer science student. My lectures were in one app, my flashcards
            in another and my diagrams in a third, and none of them knew the others existed. Unote
            is what I built to stop doing that.
          </p>
          <p className="mkt-maker__body">
            It is the notebook I use for my own degree, which is the only reason the awkward parts -
            importing a lecture, revising from your own notes, drawing on top of a page - work the
            way they do.
          </p>
        </div>

        <ul className="mkt-maker__facts">
          {FACTS.map((f) => (
            <li key={f.title} className="mkt-maker__fact">
              <h3 className="mkt-maker__fact-title">{f.title}</h3>
              <p className="mkt-maker__fact-body">{f.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
