# Dark chrome redesign

Source: the "UI redesign with dark chrome" design file (`Unote Editor.dc.html`).

## What this was

The app's structure already matched the design. Every bar in the mock existed as a
component, so this was a visual-layer change, not a rebuild.

| Design element | Existing component |
| --- | --- |
| Document toolbar (Insert, panel switches, Share, More, saved chip) | `features/editor/NoteActionBar.tsx` |
| Bottom formatting toolbar | `features/editor/formatbar/FormatBar.tsx` |
| Status bar (pages, A4, header & footer, zoom, export) | `features/editor/pagination/` |
| Sidebar (nav, notebooks, user row, icon footer, AI pill) | `components/Sidebar.tsx` |
| Tab strip | `features/tabs/TabStrip.tsx` |
| Breadcrumb, title, tag row, starter card, paper sheet | `features/editor/NotePage.tsx` |

The lever: **3,165 `var(--token)` usages against 56 hard-coded hexes** across 20k lines
of CSS. Re-pointing the token contract reskinned the whole app at once, which is why the
scope could be every screen rather than one.

## The surface inversion

The governing idea is a DESK and things resting on it. The workspace is the *darkest*
surface and the chrome sits above it, which inverts the old ramp where `--bg` was the
lightest thing on screen:

```
sunken  <  desk  <  toolbar  <  chrome  <  card
```

94 CSS rules use `background: var(--bg)`, and sampling them showed `--bg` dresses
**content surfaces** (cards, panels, popovers, pickers), not a backdrop. So `--bg` kept
its role and only changed value, and the recessed workspace became a new `--desk`
applied deliberately to `.app-shell`. Hover and selection became veils rather than
per-surface hexes, so a row keeps its weight on the desk, the chrome and a card alike.

## The paper is light in both themes

The note sheet stays a warm white under the dark chrome. That is what makes the app read
as a document editor rather than a dark app with a text box, and it is also the most
destructive thing here: the dark theme sets `--ink` to a near-white, so white paper means
white text on white paper.

`.folio-paged` re-declares the light palette for its subtree. It is scoped to exactly
where paper exists, because with pagination off the note sits on `--bg` and the theme's
own ink is already correct. It works at all because the codebase is token-driven: one
container re-declaring the tokens carries body, headings, links, tables, captions and
syntax highlighting with it, and no component needs to know it is sitting on paper.

**That override was wrong the first time in a way tests could not see.** It re-declared
the ink and the `-soft` fills but not `--warn`, `--danger` and `--ok` themselves, so
inside the paper the dark theme's amber (a colour meant for a near-black ground) drew the
"this block is taller than one page" warning at 2.14:1. It is 6.21:1 now.

## Contrast

Two tiers in the design do not clear AA, and three existing semantic colours stopped
clearing it once the surfaces inverted. Everything below was measured, first by solving
against the surface list and then against the running app.

| Tier | As drawn | Shipped | Worst surface |
| --- | --- | --- | --- |
| `--txt-3` -> `--ink-3` | 4.43 dark, 3.19 light | `#95928f` / `#585550` | 4.51 / 4.49 |
| `--txt-4` -> `--ink-4` | 2.52 dark, 2.07 light | decoration only, never text | n/a |
| `--warn` light | 3.43 on the desk | `#805500` | 4.57 |
| `--danger` light | 4.05 on the desk | `#b82029` | 4.52 |
| `--ok` light | 4.12 on the desk | `#166d2f` | 4.51 |
| `#b45309`, hard-coded in 5 places | 4.33 on the sidebar | `var(--warn)` | 5.63 |

`--ink-4` is the one place the design was not followed. It cannot reach AA at any value
that stays visually distinct from `--ink-3`, because the band between 4.5 and `--ink-2`'s
5.56 is too narrow to hold a fourth step. It survives as an icon and chevron tint, and
every place the mock used it for TEXT (the search placeholder, the Ctrl/Cmd+K hint, the
NOTEBOOKS caption, the account email, "Add a tag...", the FORMAT label) uses `--ink-3`.

The dark theme's four semantic colours all clear 5.35 or better untouched.

## Icons

Material Symbols Rounded, weight 300, FILL 0 - the vocabulary the design is drawn in, but
**not** the font the design links. `vercel.json` and `server/src/lib/csp.ts` pin:

```
style-src 'self' 'unsafe-inline'   (no fonts.googleapis.com)
font-src  'self' data:             (no fonts.gstatic.com)
```

Self-hosting the woff2 instead would ship megabytes for ~77 glyphs. `scripts/gen-icons.mjs`
bakes only the glyphs used into `src/components/iconPaths.ts`, so
`@material-symbols/svg-300` stays a devDependency and nothing extra reaches the browser.
It exits non-zero on a name it cannot resolve, which caught four that Material has since
renamed (`expand_more`, `auto_awesome`, `smartphone`, and no `auto_awesome` off-variant).

`Icon.tsx` keeps its public API, so all 176 call sites were untouched. Newsreader and
JetBrains Mono were already self-hosted via `@fontsource`; `--font-mono` moved from IBM
Plex Mono to JetBrains Mono to match the design's caption face.

To add an icon: extend `MAP` in `scripts/gen-icons.mjs`, then `npm run gen:icons -w web`.

## Other decisions worth knowing

- **Assistant left the segmented control.** The other four toggles reveal something
  already in the note; this one brings something new. It keeps `aria-pressed` and the
  `assistant-open` test id the e2e specs match on.
- **Insert is accent, and the app-wide `.btn-primary` is not.** That one means "the
  primary action of this page"; Insert is the add affordance, sharing its blue with the
  nav rail and the notebook dots.
- **`.folio-btn-primary` hover is now a filter**, which collides with the open-menu state
  that also used filter - they used to write to different properties and compose. Both
  open-state selectors name `.folio-btn-primary` to outweigh the later hover rule.
- **Notebook emoji stayed.** The mock shows colour dots, but the emoji are user data with
  a picker behind them, so replacing them was out of scope for a reskin. The row geometry
  matches; the identity glyph does not.
- **"On" in the format bar is neutral, not accent.** Several controls are on at once -
  bold inside a heading inside a list - and an accent tint made the bar louder than the
  note it describes.

## Verifying this locally

Guest mode runs the whole app with **no Postgres**, which is how the UI above was
measured. `/try` seeds a notebook and notes into browser storage, so the web dev server
alone gets you the real sidebar, tabs, editor, paper and bars:

```
npm run dev -w web -- --port 5199 --strictPort
```

Port 5173 belongs to another app on this machine. Note that `npm run test -w server`
drops the dev database, so do browser checks first.

Two traps make a naive in-page contrast sweep lie: the note's paper is an
absolutely-positioned **sibling behind** the ProseMirror content rather than an ancestor,
so walking up the DOM finds the desk instead; and gradients report
`backgroundColor: transparent` while `color(srgb ...)` values parse as 0-255 if you regex
the numbers out. All three produce false failures.
