// Warm hero landing that wraps the sign-in / sign-up forms. Renders outside the app
// shell (see main.tsx), so it carries its own top bar, wordmark and theme toggle.
//
// The hero band and the form panel deliberately COMMIT to a golden-hour look in both
// themes - that warmth is the brand's first impression. The panel re-tints the shared
// form primitives by overriding the design tokens they read (see landing.css), so the
// existing Field / validation / submit logic is reused untouched. The testimonials
// band and page chrome below follow the active light/dark theme.
import { useRef, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import Icon from '../../components/Icon';
import { useTheme } from '../../lib/theme';
import { testimonials } from './testimonials';
import './landing.css';

// The "Get started now" button either routes to sign-up (from the login page) or, when
// the sign-up form is already on screen, scrolls to it and focuses the first field.
type GetStarted = { to: string } | { focusPanel: true };

export function AuthLanding({
  getStarted,
  secondary,
  panelTitle,
  panelSubtitle,
  panelFooter,
  children,
}: {
  getStarted: GetStarted;
  secondary?: ReactNode;
  panelTitle: string;
  panelSubtitle: string;
  panelFooter?: ReactNode;
  children: ReactNode;
}) {
  const [theme, , toggleTheme] = useTheme();
  const panelRef = useRef<HTMLDivElement>(null);

  const focusPanel = () => {
    const panel = panelRef.current;
    if (!panel) return;
    panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Land keyboard focus inside the form, not just near it. A short delay lets the
    // smooth scroll begin first (an immediate focus cancels it in some browsers).
    const input = panel.querySelector('input');
    window.setTimeout(() => input?.focus(), 80);
  };

  const primaryCta =
    'to' in getStarted ? (
      <Link className="btn landing-cta__primary" to={getStarted.to}>
        Get started now
        <Icon name="arrow-right" size={16} />
      </Link>
    ) : (
      <button type="button" className="btn landing-cta__primary" onClick={focusPanel}>
        Get started now
        <Icon name="arrow-right" size={16} />
      </button>
    );

  return (
    <div className="landing">
      <header className="landing-topbar">
        <div className="landing-brand">
          <span className="landing-brand__mark" aria-hidden="true">
            📓
          </span>
          <span className="landing-brand__word">Unote</span>
        </div>
        <button
          type="button"
          className="icon-btn landing-topbar__theme"
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          onClick={toggleTheme}
        >
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
        </button>
      </header>

      <section className="landing-hero">
        <div className="landing-hero__glow" aria-hidden="true" />
        <div className="landing-hero__sparks" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>

        <div className="landing-hero__inner">
          <div className="landing-hero__copy">
            <p className="landing-eyebrow">Notes - Notebooks - Flashcards</p>
            <h1 className="landing-hero__title">Your notebooks, lit from within.</h1>
            <p className="landing-hero__lede">
              Unote gathers your lecture notes, notebooks and flashcards into one warm,
              quiet place to study - so revision feels less like a slog and more like
              settling in with a good book.
            </p>
            <div className="landing-cta">
              {primaryCta}
              {secondary}
            </div>
            <p className="landing-trust">Free to use. Your notes stay yours.</p>
          </div>

          <div className="landing-panel" id="get-started" ref={panelRef}>
            <div className="landing-panel__head">
              <h2 className="landing-panel__title">{panelTitle}</h2>
              <p className="landing-panel__subtitle">{panelSubtitle}</p>
            </div>
            {children}
            {panelFooter ? <p className="landing-panel__alt">{panelFooter}</p> : null}
          </div>
        </div>
      </section>

      <section className="landing-quotes" aria-labelledby="landing-quotes-heading">
        <div className="landing-quotes__head">
          <p className="landing-eyebrow landing-eyebrow--dark">Student voices</p>
          <h2 id="landing-quotes-heading" className="landing-quotes__title">
            What students say
          </h2>
        </div>
        <ul className="landing-quotes__grid">
          {testimonials.map((t, i) => (
            <li key={i} className="quote-card">
              {t.placeholder ? <span className="quote-card__tag">Sample</span> : null}
              <p className="quote-card__quote">{t.quote}</p>
              <div className="quote-card__who">
                <span className="quote-card__name">{t.name}</span>
                <span className="quote-card__role">{t.role}</span>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <footer className="landing-foot">
        <span className="landing-brand__word">Unote</span>
        <span className="landing-foot__note">A calmer home for your coursework.</span>
      </footer>
    </div>
  );
}
