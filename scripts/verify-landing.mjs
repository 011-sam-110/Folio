// Assertions for the marketing landing page, aimed at the failure mode this page keeps
// hitting: an element whose default state is invisible and which only becomes visible if
// an animation runs. A screenshot count proves nothing about that; these checks do.
//
//   node scripts/verify-landing.mjs [--base http://localhost:5199]
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = argOf('--base', 'http://localhost:5199');

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const browser = await chromium.launch();

for (const vp of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
]) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  // A 401 from /api/auth/me is the expected answer when no API server is running behind
  // the dev server; it is the signed-out path, not a fault.
  const ignorable = (t) => /401|Unauthorized|\/api\/auth\/me/.test(t);
  page.on('console', (m) => m.type() === 'error' && !ignorable(m.text()) && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => !ignorable(String(e)) && consoleErrors.push(String(e)));

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.locator('h1').first().waitFor({ state: 'visible', timeout: 20_000 });

  // The product replica must occupy real space and be opaque. It previously carried an
  // entrance animation that left it at opacity 0 whenever the timeline did not complete.
  const frame = page.locator('.mkt-shot__frame');
  const box = await frame.boundingBox();
  const opacity = await page
    .locator('.mkt-shot')
    .evaluate((el) => getComputedStyle(el).opacity);
  check(
    `${vp.name}: product shot is rendered and opaque`,
    !!box && box.height > 200 && opacity === '1',
    `h=${box?.height ?? 0} opacity=${opacity}`,
  );

  // The typed line must contain its full text regardless of whether the typing ran.
  const typed = (await page.locator('.mkt-shot__typed').innerText()).trim();
  check(
    `${vp.name}: typed line has its full text`,
    typed.endsWith('using a queue.'),
    JSON.stringify(typed.slice(0, 40) + '…'),
  );

  // The selection toolbar is the payoff; it must persist, not animate away.
  await page.waitForTimeout(4200);
  check(
    `${vp.name}: "Make flashcard" toolbar is still visible after the sequence`,
    await page.locator('.mkt-shot__toolbar').isVisible(),
  );

  // The pencil sketch must be drawn even if the observer never fires. Measured via
  // computed style, NOT getBoundingClientRect: the wipe is a <rect> inside a <clipPath>,
  // which is never itself rendered, so its bounding box is always zero and would report a
  // false failure.
  await page.locator('.mkt-viz--canvas').scrollIntoViewIfNeeded();
  await page.waitForTimeout(2600);
  const wipeWidth = await page
    .locator('.mkt-sketch__wipe')
    .evaluate((el) => parseFloat(getComputedStyle(el).width) || 0);
  check(`${vp.name}: pencil sketch is drawn`, wipeWidth > 100, `wipe width=${Math.round(wipeWidth)}`);

  // No horizontal overflow: the page body must never scroll sideways.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check(`${vp.name}: no horizontal overflow`, overflow <= 1, `${overflow}px`);

  check(`${vp.name}: no console errors`, consoleErrors.length === 0, consoleErrors[0] ?? '');

  await ctx.close();
}

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
