# Unote marketing landing page - design

Date: 2026-07-22
Status: approved, ready to implement

## Problem

`/login` and `/signup` currently render `AuthLanding`: a warm golden-hour hero with a
sign-in form bolted alongside it and a testimonials band beneath. It is a login screen
wearing marketing clothes. A signed-out visitor to `/` is redirected straight to it, so
the product is never actually pitched - there is no page that explains what Unote is,
what it does, or why a student should sign up.

The reference sites supplied (Notion, plus two agency heroes) are all true landing
pages: nav → hero → product visual → features → proof → closing CTA, with auth as a
separate destination.

## Research findings that constrain the design

From 2026 SaaS landing-page practice:

- High-performing H1s run **under 8 words**. The constraint forces clarity.
- Effective heroes do three things: name a specific **outcome** (not a category), name
  the **person** it is built for, and **show the product**.
- **Real product UI outperforms abstract illustration**, even when the screenshot is
  imperfect. Illustrated heroes are the pattern being abandoned.
- **One** primary CTA. Each additional competing CTA reduces the chance any is clicked.
  Where time-to-value is under ten minutes, the primary CTA is signup.
- ~65% of landing traffic is mobile; the page is designed phone-first.
- The 2026 differentiator is an animated or interactive product demo in the hero rather
  than a static image.

The existing captures in `docs/ui-capture/` are unusable as hero art: they predate the
"Unote" wordmark and show a near-empty note.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Structure | Real marketing page at `/` | Matches every reference; auth stops competing with the pitch |
| Art direction | Clean light, Notion-like | Safest read as "professionally marketed"; product is a Notion alternative |
| AI pitch | Featured unconditionally | Owner's call, made with the production-gateway caveat in view |
| Old warm hero | Deleted | Replaced by the new direction; recoverable from git |
| Hero visual | DOM replica of real Unote UI | Research: show the product. Also drops three.js from the marketing bundle |
| Theme | Committed to light in both themes | Same pattern the warm hero already used; matches the reference |

## Architecture

New directory `web/src/features/marketing/`:

```
marketing/
  LandingPage.tsx        composition root, section order only
  sections/
    MarketingNav.tsx     sticky nav + mobile sheet
    Hero.tsx             badge, H1, lede, CTAs, trust line
    ProductShot.tsx      DOM replica of the app UI, animated on entry
    CapabilityStrip.tsx  honest substitute for a customer-logo bar
    FeatureBento.tsx     six feature cards, each with a mini visual
    AiBand.tsx           optional-AI section
    Testimonials.tsx     existing quotes, Sample tags preserved
    ClosingCta.tsx       final CTA + footer
  visuals/               small presentational mocks used by the bento
  marketing.css          all page styling, scoped under .mkt
```

Each section is a self-contained component taking no props, so `LandingPage` reads as an
ordered list of sections and any one can be reordered or dropped without touching the
others.

### Routing

`/` becomes public. A `RootRoute` component reads `useAuth()` and renders `<LandingPage />`
when `user` is null, or the existing guarded `<App />` subtree when signed in. No loading
branch is needed: `AuthProvider` already withholds render until the first `/me` settles.

`/login` and `/signup` revert to the pre-existing `AuthShell` centred card, gaining a
back-link to `/`. Their form logic, validation and OAuth buttons are untouched.

### Deletions

`AuthLanding.tsx`, `landing.css`, `HeroBook.tsx`, `heroBookScene.ts`, and the
`--warm-*` / `--parchment-*` token block in `tokens.css` once nothing reads it.

## Page structure

1. **Sticky nav** - wordmark, section links, `Log in`, `Get started free`. Backdrop-blurs
   once scrolled. Mobile: disclosure sheet.
2. **Hero** - badge pill, H1 with an inline highlight pill on the key word, lede, one
   primary CTA plus a quiet secondary, trust line.
3. **Product visual** - browser-framed DOM replica of the Unote editor: sidebar,
   notebook tree, note with tags, wikilink, slash menu. Animates once on entry.
4. **Capability strip** - Notes · Boards · Flashcards · Lectures · Ink · Search. Replaces
   the customer-logo bar the references use, which Unote cannot honestly fill.
5. **Feature bento** - Write, Link, Study, Capture, Canvas + Ink, Find. Each card carries
   a small purpose-built visual rather than an icon.
6. **AI band** - "Optional AI, on your terms": ask across your notes, summarise, turn a
   selection into flashcards. Emphasises that it is off by default.
7. **Testimonials** - the four existing quotes from `auth/testimonials.ts`, keeping their
   visible `Sample` tags. Moved, not rewritten.
8. **Closing CTA + footer**.

## Copy

- H1: **Where your whole degree comes together.** (6 words; "degree" in the highlight
  pill; names the audience and the outcome)
- Lede: notes, lecture recordings, flashcards and boards in one app - with optional AI
  that only helps when you ask for it.
- Primary CTA: `Start writing - it's free`. Secondary: `See how it works`.
- Trust line: free to use, no card, your notes stay yours.

## Non-functional requirements

- **No new dependencies.** Plain CSS over the existing token system, with `--mkt-*`
  tokens scoped to `.mkt`.
- **Accessibility.** AA contrast on every text/surface pair, semantic landmarks, visible
  focus, keyboard-operable nav sheet, `prefers-reduced-motion` honoured by every
  animation.
- **Performance.** No raster images. Below-fold reveals driven by one shared
  IntersectionObserver, not per-element listeners.
- **Mobile-first.** Designed at 390px, enhanced upward.

## Verification

1. `npm run build -w web` typechecks and builds.
2. Existing suites still pass: `npm run test -w server`, `npm run e2e`. E2E specs that
   assume `/` redirects to `/login` when signed out will need updating - that assumption
   is now deliberately false.
3. Screenshots captured at desktop and phone widths.
4. A review agent grades the screenshots against professionally marketed sites. Findings
   are applied and the loop repeats until the agent returns nothing further.
