// The public marketing page at "/". A signed-out visitor lands here; a signed-in one
// never sees it (see RootRoute in main.tsx), so nothing below assumes a session.
//
// Section order is the whole of this file's job. Each section owns its own markup and
// takes no props, so one can be reordered or dropped without touching the others.
import MarketingNav from './sections/MarketingNav';
import Hero from './sections/Hero';
import CapabilityStrip from './sections/CapabilityStrip';
import FeatureBento from './sections/FeatureBento';
import AiBand from './sections/AiBand';
import MakerNote from './sections/MakerNote';
import ClosingCta from './sections/ClosingCta';
import './marketing.css';

export default function LandingPage() {
  return (
    // .mkt carries the page's own palette. The landing commits to the light,
    // paper-and-ink look in BOTH themes - see the token block in marketing.css.
    <div className="mkt">
      <MarketingNav />
      <main id="main">
        <Hero />
        <CapabilityStrip />
        <FeatureBento />
        <AiBand />
        <MakerNote />
        <ClosingCta />
      </main>
    </div>
  );
}
