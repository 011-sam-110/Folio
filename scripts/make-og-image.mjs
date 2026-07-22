// Renders web/public/og.png, the 1200x630 card shown when the site is shared on social
// or pulled into a link preview.
//
// Generated rather than hand-designed so it stays in step with the landing page: same
// paper, same ink, same Fraunces display face, same highlighter swipe on the same word.
// It is committed as a PNG because that is what the platforms need - Twitter and Facebook
// will not render an SVG - and because the CSP is img-src 'self', so it must be
// first-party anyway.
//
// Re-run after any change to the hero headline:  node scripts/make-og-image.mjs
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const out = path.join(root, 'web', 'public', 'og.png');

// The real brand face, loaded straight out of node_modules so the card cannot drift from
// the site. The "wonk" subset is the one the site itself imports.
const fontPath = path.join(
  root,
  'node_modules',
  '@fontsource-variable',
  'fraunces',
  'files',
  'fraunces-latin-wonk-normal.woff2',
);
if (!fs.existsSync(fontPath)) {
  console.error(`Missing font: ${fontPath}\nRun npm install first.`);
  process.exit(1);
}
const fontUrl = pathToFileURL(fontPath).href;

const html = `<!doctype html>
<meta charset="utf-8" />
<style>
  @font-face {
    font-family: 'Fraunces';
    src: url('${fontUrl}') format('woff2-variations');
    font-weight: 100 900;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 1200px; height: 630px;
    background: #fdfcfa;
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    color: #16181d;
    display: flex; flex-direction: column; justify-content: center;
    padding: 70px 84px 112px;
    position: relative; overflow: hidden;
  }
  /* the hero's ambient lamp, flattened */
  .lamp {
    position: absolute; top: -30%; left: -8%; width: 900px; height: 900px;
    background: radial-gradient(circle at 50% 50%, rgba(255,226,122,.42), transparent 64%);
    filter: blur(46px);
  }
  .lamp2 {
    position: absolute; bottom: -42%; right: -12%; width: 760px; height: 760px;
    background: radial-gradient(circle at 50% 50%, rgba(79,70,229,.10), transparent 66%);
    filter: blur(46px);
  }
  .inner { position: relative; }
  .brand {
    display: flex; align-items: center; gap: 14px; margin-bottom: 46px;
  }
  .brand svg { width: 38px; height: 38px; }
  .brand span {
    font-family: 'Fraunces', Georgia, serif; font-variation-settings: 'WONK' 1;
    font-size: 38px; font-weight: 600; letter-spacing: -.01em;
  }
  h1 {
    font-family: 'Fraunces', Georgia, serif;
    font-variation-settings: 'WONK' 1, 'SOFT' 0;
    font-size: 74px; font-weight: 600; line-height: 1.06; letter-spacing: -.022em;
    max-width: 15ch;
  }
  .mark { position: relative; display: inline-block; white-space: nowrap; }
  .mark span { position: relative; z-index: 1; }
  .mark svg {
    position: absolute; z-index: 0; left: -3.5%; bottom: 6%; width: 107%; height: 84%;
  }
  p {
    margin-top: 30px; font-size: 28px; line-height: 1.45; color: #4e5560; max-width: 36ch;
  }
  .foot {
    position: absolute; left: 84px; bottom: 54px;
    font-family: ui-monospace, Consolas, monospace;
    font-size: 21px; letter-spacing: .09em; text-transform: uppercase; color: #6d7480;
  }
</style>
<div class="lamp"></div>
<div class="lamp2"></div>
<div class="inner">
  <div class="brand">
    <svg viewBox="0 0 20 20" fill="none">
      <path d="M4 3.2a1.6 1.6 0 0 1 1.6-1.6h9.2a1 1 0 0 1 1 1v14.8a1 1 0 0 1-1 1H5.6A1.6 1.6 0 0 1 4 16.8V3.2Z" fill="#16181d"/>
      <path d="M15.8 4.6h1.1a.6.6 0 0 1 .6.6v9.6a.6.6 0 0 1-.6.6h-1.1V4.6Z" fill="#ffd23f"/>
      <path d="M6.7 1.6v16.8" stroke="#fdfcfa" stroke-width="1" stroke-opacity=".5"/>
    </svg>
    <span>Unote</span>
  </div>
  <h1>Where your whole <span class="mark"><span>degree</span><svg viewBox="0 0 240 56" preserveAspectRatio="none"><path d="M4 12 C 46 3, 96 18, 146 8 S 212 3, 236 11 L 234 48 C 196 40, 148 54, 100 46 S 30 50, 6 45 Z" fill="#ffe27a"/><path d="M8 29 C 52 23, 98 36, 150 27 S 208 23, 232 29 L 231 44 C 198 38, 148 51, 102 42 S 32 46, 7 41 Z" fill="#ffd23f" opacity=".55"/></svg></span> comes together.</h1>
  <p>Lecture notes, recordings, flashcards and boards in one place.</p>
</div>
<div class="foot">Free to use &middot; Built for university students</div>
`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(300);
await page.screenshot({ path: out });
await browser.close();

const { size } = fs.statSync(out);
console.log(`wrote ${path.relative(root, out)}  (1200x630, ${(size / 1024).toFixed(0)} KB)`);
