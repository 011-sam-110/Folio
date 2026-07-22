// Screenshot the marketing landing page for design review.
//
// Captures a full-page shot plus a first-viewport shot at each width, because the two
// answer different questions: the full page shows composition and rhythm, the viewport
// shot shows what a visitor actually decides on in the first five seconds.
//
//   node scripts/capture-landing.mjs [--base http://localhost:5199] [--out docs/landing-review]
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const BASE = argOf('--base', 'http://localhost:5199');
const OUT = path.resolve(argOf('--out', 'docs/landing-review'));

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'laptop', width: 1180, height: 800 },
  { name: 'tablet', width: 834, height: 1112 },
  { name: 'phone', width: 390, height: 844 },
];

const ROUTES = [
  { name: 'landing', path: '/' },
  { name: 'login', path: '/login' },
  { name: 'signup', path: '/signup' },
];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const captured = [];
const failed = [];

for (const vp of VIEWPORTS) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  for (const route of ROUTES) {
    try {
      // Not networkidle: the app's /me call can be left hanging by a dev server with no
      // API behind it, and waiting for silence then times out on a page that is already
      // fully painted. Wait for the DOM, then for something real to be on screen.
      await page.goto(`${BASE}${route.path}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.locator('h1').first().waitFor({ state: 'visible', timeout: 20_000 });
      // The hero animation is a one-shot sequence ending at ~5.8s. Let it finish so the
      // review sees the resting state rather than a half-typed line.
      await page.waitForTimeout(7000);

      const dir = path.join(OUT, vp.name);
      fs.mkdirSync(dir, { recursive: true });

      const viewportShot = path.join(dir, `${route.name}-viewport.png`);
      await page.screenshot({ path: viewportShot });
      captured.push(path.relative(OUT, viewportShot));

      const fullShot = path.join(dir, `${route.name}-full.png`);
      await page.screenshot({ path: fullShot, fullPage: true });
      captured.push(path.relative(OUT, fullShot));
    } catch (err) {
      failed.push({ viewport: vp.name, route: route.path, error: String(err).split('\n')[0] });
    }
  }

  await context.close();
}

await browser.close();

// Record what was NOT captured too. A count of successes on its own has, in this repo's
// history, hidden the fact that every shot was of the same wrong page.
fs.writeFileSync(
  path.join(OUT, 'manifest.json'),
  JSON.stringify({ base: BASE, captured, failed }, null, 2),
);

console.log(`captured ${captured.length} shots into ${OUT}`);
if (failed.length) {
  console.log(`FAILED ${failed.length}:`);
  for (const f of failed) console.log(`  ${f.viewport} ${f.route} - ${f.error}`);
}
