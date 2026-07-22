// Sticky top nav, plus the docked call to action that stands in for it on a phone.
//
// The nav is transparent over the top of the hero and picks up a blurred surface and a
// hairline once the page has scrolled, so it never sits as a hard bar over the headline
// but stays legible over content further down.
//
// Below 760px the nav's button collapses into the burger, which left roughly 80% of an
// 8,000px mobile scroll with no visible way to act. The dock restores one. It appears
// after the hero's own CTA has left the screen and hides again once the closing CTA is in
// view, so there are never two primary buttons competing.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Wordmark from '../Wordmark';

const LINKS = [
  { href: '#features', label: 'Features' },
  { href: '#ai', label: 'AI' },
  { href: '#maker', label: 'Who made it' },
];

export default function MarketingNav() {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dockVisible, setDockVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Two observers rather than a scroll-position threshold: the hero and the closing CTA
  // both move as the page reflows, and a hard pixel value would be wrong at every width
  // except the one it was measured at.
  useEffect(() => {
    const hero = document.querySelector('.mkt-hero__cta');
    const close = document.querySelector('.mkt-close');
    if (!hero || !close || typeof IntersectionObserver === 'undefined') return;

    let heroVisible = true;
    let closeVisible = false;
    const sync = () => setDockVisible(!heroVisible && !closeVisible);

    const heroIo = new IntersectionObserver((entries) => {
      heroVisible = entries[0].isIntersecting;
      sync();
    });
    const closeIo = new IntersectionObserver((entries) => {
      closeVisible = entries[0].isIntersecting;
      sync();
    });
    heroIo.observe(hero);
    closeIo.observe(close);
    return () => {
      heroIo.disconnect();
      closeIo.disconnect();
    };
  }, []);

  // Escape closes the mobile sheet, matching every other dismissible surface in the app.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  return (
    <>
      <a className="mkt-skip" href="#main">
        Skip to content
      </a>

      <header className={`mkt-nav${scrolled ? ' is-scrolled' : ''}`}>
        <div className="mkt-nav__inner">
          <Link className="mkt-nav__brand" to="/" aria-label="Unote home">
            <Wordmark size={22} />
            <span className="mkt-nav__word">Unote</span>
          </Link>

          <nav className="mkt-nav__links" aria-label="Sections">
            {LINKS.map((l) => (
              <a key={l.href} className="mkt-nav__link" href={l.href}>
                {l.label}
              </a>
            ))}
          </nav>

          <div className="mkt-nav__actions">
            <Link className="mkt-nav__login" to="/login">
              Log in
            </Link>
            <Link className="mkt-btn mkt-btn--primary mkt-btn--sm" to="/signup">
              Start free
            </Link>
          </div>

          <button
            type="button"
            className="mkt-nav__burger"
            aria-expanded={menuOpen}
            aria-controls="mkt-nav-sheet"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            onClick={() => setMenuOpen((o) => !o)}
          >
            <span className={`mkt-burger${menuOpen ? ' is-open' : ''}`} aria-hidden="true">
              <span />
              <span />
            </span>
          </button>
        </div>

        <div className="mkt-nav__sheet" id="mkt-nav-sheet" hidden={!menuOpen}>
          {LINKS.map((l) => (
            <a
              key={l.href}
              className="mkt-nav__sheet-link"
              href={l.href}
              onClick={() => setMenuOpen(false)}
            >
              {l.label}
            </a>
          ))}
          <Link className="mkt-nav__sheet-link" to="/login" onClick={() => setMenuOpen(false)}>
            Log in
          </Link>
          <Link
            className="mkt-btn mkt-btn--primary mkt-nav__sheet-cta"
            to="/signup"
            onClick={() => setMenuOpen(false)}
          >
            Start writing - it&apos;s free
          </Link>
        </div>
      </header>

      <div className={`mkt-dock${dockVisible ? ' is-visible' : ''}`} aria-hidden={!dockVisible}>
        <Link
          className="mkt-btn mkt-btn--primary mkt-btn--lg mkt-dock__btn"
          to="/signup"
          tabIndex={dockVisible ? undefined : -1}
        >
          Start writing - it&apos;s free
        </Link>
      </div>
    </>
  );
}
