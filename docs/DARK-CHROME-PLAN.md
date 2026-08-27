# Dark chrome redesign — implementation plan

Source: Claude Design project `0fdf4337-9535-4969-8beb-40f23f0f7549`, file `Unote Editor.dc.html`.
Branch: `feat/dark-chrome-redesign`.

## Verdict

The app's structure already matches the design. Every bar in the mock exists as a
component today. This is a visual-layer change, not a rebuild.

| Design element | Exists today as |
| --- | --- |
| Document toolbar (Insert · Outline/Comments/Ink/Find · Assistant · Share · More · saved chip) | `features/editor/NoteActionBar.tsx` |
| Bottom formatting toolbar | `features/editor/formatbar/FormatBar.tsx` |
| Status bar (pages · A4 · header & footer · zoom · export) | `features/editor/pagination/` |
| Sidebar (nav, notebooks, user row, icon footer, AI pill) | `components/Sidebar.tsx` |
| Tab strip | `features/tabs/TabStrip.tsx` |
| Breadcrumb, title, tag row, starter card, paper sheet | `features/editor/NotePage.tsx` |

The lever: **3,165 `var(--token)` usages against 56 hard-coded hexes** across 20k lines
of CSS. Re-pointing the token contract reskins the whole app at once.

## Decisions taken (Sampo, 2026-08-27)

1. **Scope — whole app.** The chrome is global, so every screen inherits it. The editor
   is the reference implementation.
2. **Icons — adopt Material Symbols Rounded**, self-hosted via npm.
3. **Theme — rebuild both palettes to the design's colours, keep the current default**
   (follow OS preference, remember the user's toggle). The design file defaults to dark;
   we adopt its look, not its default.

## Two things that break if the design is implemented literally

### 1. The Google Fonts link is blocked in production

`vercel.json` and `server/src/lib/csp.ts` pin:

```
style-src 'self' 'unsafe-inline'
font-src  'self' data:
```

The design's `<link href="https://fonts.googleapis.com/...">` is refused on both
directives. Newsreader and JetBrains Mono are already self-hosted through `@fontsource`
and need no change. Material Symbols Rounded is the only new face — install the
`material-symbols` npm package so it is served from `'self'`.

`server/test/csp.test.ts` guards the CSP; run it after any change here.

### 2. `--txt-4` fails AA and carries real text

The design draws its fourth text tier at `rgba(234,231,226,.32)` — roughly 2.4:1 on
`--chrome`. It is not decoration: it carries the search placeholder, `⌘K`, the
`NOTEBOOKS` label, the user's email, "Add a tag…" and the `FORMAT` label.

`tokens.css` already documents measured tuning for exactly this tier (see the `--ink-3`
comment, which records ratios against every surface it lands on). Adopt the design's
value everywhere it clears 4.5:1; lift only this tier where it does not, and record the
measured ratios in the same style as the existing comments.

## The surface-token hazard

94 CSS rules use `background: var(--bg)`. Sampling them (`auth.css`, `comments.css`,
`aiReview.css`, `checkPicker.css`, `editor.css`) shows `--bg` dresses **content
surfaces** — cards, panels, popovers, pickers — not a backdrop.

The design's `--work` is the opposite: a *recessed desk* the paper sheet floats on,
`#dcd8d0` in light. Mapping `--bg → --work` would turn 94 modals and inputs muddy grey.

Correct mapping:

- `--bg` keeps its raised-surface role → design `--field` / `--tab-active`
  (`#ffffff` light, `#100f0e` dark).
- **New `--desk` token** → design `--work` (`#dcd8d0` light, `#100f0e` dark), applied
  deliberately to the editor workspace backdrop only.

In dark the two are the same colour, so only the light theme needs the care.

## Token map

Existing contract names are load-bearing ("relied on by other agents' CSS — never
rename them"), so the design's colours are pointed *into* the existing names wherever a
role already exists, and only genuinely new roles get new tokens.

| Design var | Maps to | Light | Dark |
| --- | --- | --- | --- |
| `--work` | `--desk` *(new)* | `#dcd8d0` | `#100f0e` |
| `--chrome` | `--bg-sidebar` | `#f0eeea` | `#171614` |
| `--chrome-2` | `--bg-paper` | `#f5f3ef` | `#141312` |
| `--chrome-3` | `--bg-sunken` *(new)* | `#e9e6e0` | `#0e0d0c` |
| `--tab-active` / `--field` | `--bg` | `#ffffff` | `#100f0e` |
| `--txt` / `--txt-2` / `--txt-3` | `--ink` / `--ink-2` / `--ink-3` | — | — |
| `--txt-4` | `--ink-4` *(new, contrast-corrected)* | — | — |
| `--title` | `--ink-title` *(new)* | `#191713` | `#f4f1ec` |
| `--hov` / `--hov-soft` / `--sel` | `--bg-hover` / `--bg-hover-soft` *(new)* / `--bg-active` | — | — |
| `--btn-face` / `--btn-face-hov` | `--tint` / `--tint-hover` *(new)* | — | — |
| `--card-a` / `--card-b` | `--bg-elevated` / `--bg-elevated-2` *(new)* | — | — |
| `--glow`, `--paper-shadow`, `--count-bg`, `--teal-*` | new tokens, same names | — | — |

Also: `--font-mono` moves from IBM Plex Mono to JetBrains Mono to match the design's
caption face. Both are already self-hosted.

## Build order

Each phase leaves the app working.

1. **Baseline.** Capture screenshots of the current UI and confirm the suites are green
   *before* touching anything, so any red later is attributable.
2. **Token layer.** Rewrite both palettes in `tokens.css`, add the new tokens, apply
   `--desk` to the workspace. Most of the reskin lands here.
3. **Icons.** Install `material-symbols`; rewrite `Icon.tsx` internals to render symbols
   while keeping the `<Icon name="…" />` API, so all 176 call sites stay unchanged. Map
   the 43 existing names onto symbol names.
4. **Chrome.** Sidebar (search field, nav rows, section caption, notebook rows, user row,
   icon footer, AI pill), TabStrip, NoteActionBar, FormatBar, status bar.
5. **Editor page.** Breadcrumb, Newsreader title, tag row, starter card, paper sheet
   shadow and tint.
6. **Verification.** Contrast measurement, `npm run test -w server` (CSP test included),
   `npm run test -w web`, build, e2e, and a visual sweep in a real browser.

## Local run notes

- Port 5173 belongs to another app. Start the web side on its own port:
  `npm run dev -w web -- --port 5199 --strictPort`.
- **`npm run test -w server` drops the dev database.** Do browser checks *before*
  running the server suite.
- e2e uses its own `folio_e2e` database and ports 4796/5196, so it is safe to run
  alongside the dev servers.
