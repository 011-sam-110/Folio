// Capture the whole UI surface: every route, at every breakpoint, in both themes,
// plus the states you only reach by interacting (menus, modals, empty vs populated).
//
// A reviewer agent grades these screenshots, so the value is in COVERAGE. Anything
// this script fails to open is a blind spot the review will silently pass. It
// therefore records what it captured AND what it could not, into manifest.json,
// rather than quietly skipping.
//
//   node scripts/capture-ui.mjs [--base http://localhost:5173] [--out docs/ui-capture]
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const BASE = argOf('--base', 'http://localhost:5173');
const API = argOf('--api', BASE.includes('5173') ? 'http://localhost:4780' : BASE);
const OUT = path.resolve(argOf('--out', 'docs/ui-capture'));

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'tablet', width: 834, height: 1112 },
  { name: 'desktop', width: 1440, height: 900 },
];
const THEMES = ['light', 'dark'];

const manifest = { base: BASE, captured: [], failed: [], startedAt: new Date().toISOString() };

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

/** Create an account and return its cookies, so captures show a populated app. */
async function makeAccount(request) {
  const email = `capture${Date.now()}@folio.local`;
  const res = await request.post(`${API}/api/auth/signup`, {
    data: { email, password: 'ui capture password', displayName: 'Ada Lovelace' },
  });
  if (!res.ok()) throw new Error(`signup failed: ${res.status()} ${await res.text()}`);
  return email;
}

/**
 * Give the account enough content that pages render their real state rather than
 * empty states. Empty states are captured separately from a fresh account.
 */
async function seedContent(request) {
  const nbs = await (await request.get(`${API}/api/notebooks`)).json();
  const notebookId = nbs.notebooks?.[0]?.id;
  if (!notebookId) throw new Error('no starter notebook');

  const notes = [
    { title: 'Breadth-First Search', tags: ['algorithms', 'week1'], body: 'BFS explores a graph level by level using a queue. See [[Dijkstra]].' },
    { title: 'Dijkstra', tags: ['algorithms'], body: 'Shortest paths with non-negative weights. Relaxation over a priority queue.' },
    { title: 'Normalisation', tags: ['databases'], body: 'A table is in 3NF when every non-key attribute depends on the key, the whole key, and nothing but the key.' },
  ];
  const ids = [];
  for (const n of notes) {
    const created = await (await request.post(`${API}/api/notes`, {
      data: { notebookId, title: n.title },
    })).json();
    const id = created.note.id;
    await request.patch(`${API}/api/notes/${id}`, {
      data: {
        title: n.title,
        tags: n.tags,
        contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: n.body }] }] },
        contentText: n.body,
      },
    });
    ids.push(id);
  }

  const canvas = await (await request.post(`${API}/api/notes`, {
    data: { notebookId, title: 'Revision board', kind: 'canvas' },
  })).json().catch(() => null);

  return { notebookId, noteIds: ids, canvasId: canvas?.note?.id ?? null };
}

const PUBLIC_PAGES = new Set(['login', 'signup', 'recover']);

/**
 * Capture, but refuse to record a screenshot that isn't of what it claims to be.
 *
 * This exists because it already happened: a concurrent process reset the database
 * mid-run, the session died, and every "signed-in" route silently rendered the login
 * page. The run reported 78 successful captures - 78 pictures of a login form, filed
 * under names like `note` and `canvas`. A reviewer grading those would produce
 * confident nonsense about screens it had never actually seen.
 *
 * A capture harness that cannot tell a page from a redirect is worse than no harness,
 * because it converts a hard failure into a plausible-looking artefact.
 */
async function shoot(page, name, viewport, theme) {
  const url = page.url();
  const bouncedToAuth = /\/(login|signup|recover)(\?|#|$)/.test(url);
  if (bouncedToAuth && !PUBLIC_PAGES.has(name)) {
    manifest.failed.push({
      name,
      viewport,
      theme,
      reason: `expected an authenticated page but landed on ${url} - session lost, capture discarded`,
    });
    return false;
  }

  const dir = path.join(OUT, `${viewport}-${theme}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.png`);
  try {
    await page.screenshot({ path: file, fullPage: false });
    manifest.captured.push({ name, viewport, theme, file: path.relative(OUT, file) });
    return true;
  } catch (e) {
    manifest.failed.push({ name, viewport, theme, reason: String(e).slice(0, 200) });
    return false;
  }
}

/** Wait for the app to settle without sleeping on a fixed timer. */
async function settle(page) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function main() {
  const browser = await chromium.launch();

  // One signed-in context reused across viewports; a second fresh account is used
  // at the end so empty states are captured truthfully rather than faked.
  const ctx = await browser.newContext({ viewport: VIEWPORTS[2] });
  await makeAccount(ctx.request);
  const { notebookId, noteIds, canvasId } = await seedContent(ctx.request);

  // Prove the session actually works in a real page before capturing 70+ shots with
  // it. Cheaper to fail here than to discover afterwards that every file is a login
  // form, and it distinguishes "the app is broken" from "auth never took".
  {
    const probe = await ctx.newPage();
    await probe.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await settle(probe);
    if (/\/(login|signup)(\?|#|$)/.test(probe.url())) {
      throw new Error(
        `signed-in context was bounced to ${probe.url()} - the session did not survive. ` +
          `Nothing was captured. If another process resets the database mid-run, the user row ` +
          `behind this session disappears and every capture silently becomes a login page.`,
      );
    }
    await probe.close();
  }

  const routes = [
    ['dashboard', '/'],
    ['notebook', `/notebook/${notebookId}`],
    ['note', `/note/${noteIds[0]}`],
    ['study', '/study'],
    ['ask-ai', '/ask'],
    ['search', '/search?q=graph'],
    ['tags', '/tags'],
  ];
  if (canvasId) routes.push(['canvas', `/note/${canvasId}`]);

  for (const vp of VIEWPORTS) {
    for (const theme of THEMES) {
      const page = await ctx.newPage();
      await page.setViewportSize({ width: vp.width, height: vp.height });
      // Set the theme before first paint so nothing is captured mid-transition.
      await page.addInitScript((t) => {
        try { localStorage.setItem('folio:theme', t); } catch { /* private mode */ }
      }, theme);

      for (const [name, url] of routes) {
        try {
          await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
          await settle(page);
          await shoot(page, name, vp.name, theme);
        } catch (e) {
          manifest.failed.push({ name, viewport: vp.name, theme, reason: String(e).slice(0, 200) });
        }
      }

      // Interactive states - the ones a route-only sweep never reaches.
      try {
        await page.goto(`${BASE}/note/${noteIds[0]}`, { waitUntil: 'domcontentloaded' });
        await settle(page);
        await page.keyboard.press('Control+k');
        await settle(page);
        await shoot(page, 'quick-switcher', vp.name, theme);
        await page.keyboard.press('Escape');

        await page.keyboard.press('Control+p');
        await settle(page);
        await shoot(page, 'command-palette', vp.name, theme);
        await page.keyboard.press('Escape');
      } catch (e) {
        manifest.failed.push({ name: 'overlays', viewport: vp.name, theme, reason: String(e).slice(0, 200) });
      }

      await page.close();
    }
  }

  // Signed-out surfaces, from a context with no session at all.
  const anon = await browser.newContext({ viewport: VIEWPORTS[2] });
  for (const vp of VIEWPORTS) {
    for (const theme of THEMES) {
      const page = await anon.newPage();
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.addInitScript((t) => {
        try { localStorage.setItem('folio:theme', t); } catch { /* private mode */ }
      }, theme);
      for (const [name, url] of [['login', '/login'], ['signup', '/signup'], ['recover', '/recover']]) {
        try {
          await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
          await settle(page);
          await shoot(page, name, vp.name, theme);
        } catch (e) {
          manifest.failed.push({ name, viewport: vp.name, theme, reason: String(e).slice(0, 200) });
        }
      }
      await page.close();
    }
  }

  // Empty states, from a brand-new account that has created nothing.
  const fresh = await browser.newContext({ viewport: VIEWPORTS[2] });
  try {
    await makeAccount(fresh.request);
    const page = await fresh.newPage();
    for (const [name, url] of [['empty-dashboard', '/'], ['empty-tags', '/tags'], ['empty-study', '/study']]) {
      await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
      await settle(page);
      await shoot(page, name, 'desktop', 'light');
    }
    await page.close();
  } catch (e) {
    manifest.failed.push({ name: 'empty-states', reason: String(e).slice(0, 200) });
  }

  await browser.close();

  manifest.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(`captured: ${manifest.captured.length}`);
  console.log(`failed:   ${manifest.failed.length}`);
  for (const f of manifest.failed.slice(0, 20)) {
    console.log(`  MISSING ${f.name} [${f.viewport ?? '-'}/${f.theme ?? '-'}] ${f.reason}`);
  }
  console.log(`\noutput: ${OUT}`);

  // Non-zero exit on any gap, so a caller (or an agent driving this) cannot mistake a
  // partial sweep for full coverage.
  if (manifest.failed.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
