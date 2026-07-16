#!/usr/bin/env node
// Reusable visual-evidence generator for design critics.
//
// Boots an isolated Folio instance (fresh seeded DB on a dedicated port),
// drives it with Playwright, and writes a numbered screenshot pack to
// docs/review-pack/ plus a console-error/warning report. Every step is
// wrapped so a single failing shot doesn't take down the run — failures are
// logged and skipped, not thrown.
//
// Usage: npm run review-pack   (or: node scripts/review-pack.mjs)

import { chromium, devices } from 'playwright';
import { spawn, spawnSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 4790;
const BASE_URL = `http://localhost:${PORT}`;
const DB_PATH_REL = 'data/review.db';
const OUT_DIR = path.join(ROOT, 'docs', 'review-pack');
const THEME_KEY = 'folio:theme';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...args) => console.log('[review-pack]', ...args);
const warn = (...args) => console.warn('[review-pack]', ...args);

// ---------------------------------------------------------------------------
// Process / port plumbing (Windows)
// ---------------------------------------------------------------------------

function killPort(port) {
  let out = '';
  try {
    out = execSync('netstat -ano', { encoding: 'utf8' });
  } catch (e) {
    warn(`netstat failed, skipping stale-listener cleanup: ${e.message}`);
    return;
  }
  const re = new RegExp(`^\\s*TCP\\s+\\S*:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'gim');
  const pids = new Set();
  let m;
  while ((m = re.exec(out))) pids.add(m[1]);
  for (const pid of pids) {
    log(`killing stale listener on port ${port}: PID ${pid}`);
    try {
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
    } catch {
      // already gone
    }
  }
}

function runSeed() {
  log('seeding isolated review DB (--force)...');
  const res = spawnSync('npm run seed -w server -- --force', {
    cwd: ROOT,
    env: { ...process.env, FOLIO_DB_PATH: DB_PATH_REL },
    stdio: 'inherit',
    shell: true,
  });
  if (res.status !== 0) throw new Error('seed failed — see output above');
}

function ensureWebBuild() {
  const distIndex = path.join(ROOT, 'web', 'dist', 'index.html');
  if (fs.existsSync(distIndex)) {
    log('web/dist already built, skipping build');
    return;
  }
  log('web/dist missing — building web...');
  const res = spawnSync('npm run build -w web', { cwd: ROOT, stdio: 'inherit', shell: true });
  if (res.status !== 0) throw new Error('web build failed — see output above');
}

function startServer() {
  log(`spawning server on port ${PORT} (db=${DB_PATH_REL})...`);
  const env = { ...process.env, FOLIO_DB_PATH: DB_PATH_REL, FOLIO_PORT: String(PORT) };
  const proc = spawn('npm run start -w server', {
    cwd: ROOT,
    env,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  proc.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  proc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  return proc;
}

function killServerTree(proc) {
  if (!proc || proc.pid == null || proc.killed) return;
  log('stopping spawned server...');
  try {
    execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore' });
  } catch {
    // already exited
  }
}

async function waitForHealth(url, timeoutMs = 60_000) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (e) {
      lastErr = e;
    }
    await sleep(300);
  }
  throw new Error(`server did not become healthy at ${url} within ${timeoutMs}ms (${lastErr?.message ?? 'no response'})`);
}

async function apiGet(p) {
  const res = await fetch(`${BASE_URL}${p}`);
  if (!res.ok) throw new Error(`GET ${p} -> ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Console capture + shot bookkeeping
// ---------------------------------------------------------------------------

const consoleEvents = []; // { page, type, text }
const shots = []; // { name, status, bytes?, reason? }
let currentLabel = '(unlabeled)';

function attachConsoleCapture(page) {
  page.on('console', (msg) => {
    const type = msg.type();
    if (type === 'error' || type === 'warning') {
      consoleEvents.push({ page: currentLabel, type, text: msg.text() });
    }
  });
  page.on('pageerror', (err) => {
    consoleEvents.push({ page: currentLabel, type: 'pageerror', text: err.message });
  });
}

function mark(label) {
  currentLabel = label;
}

/** Runs `fn`, recording success/failure for `name` without throwing. */
async function shot(name, fn) {
  try {
    await fn();
    const file = path.join(OUT_DIR, name);
    const bytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
    shots.push({ name, status: 'ok', bytes });
    log(`captured ${name} (${bytes} bytes)`);
  } catch (e) {
    shots.push({ name, status: 'failed', reason: e instanceof Error ? e.message : String(e) });
    warn(`SKIP ${name}: ${e instanceof Error ? e.message : e}`);
  }
}

async function setTheme(page, theme) {
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: THEME_KEY, value: theme });
  await page.reload({ waitUntil: 'load' });
}

/** True if the caret sits in an empty, non-heading block inside the editor. */
async function caretInEmptyEditorBlock(page) {
  return page.evaluate(() => {
    const sel = window.getSelection();
    const anchor = sel?.anchorNode;
    const el = anchor?.nodeType === 1 ? anchor : anchor?.parentElement;
    return !!el?.closest?.('.folio-prosemirror') && !el?.closest?.('h1, h2, h3') && (anchor?.textContent ?? '').length === 0;
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  killPort(PORT);
  ensureWebBuild();
  runSeed();

  const serverProc = startServer();
  let browser;
  try {
    await waitForHealth(`${BASE_URL}/api/health`);
    log('server healthy');

    // Resolve seeded IDs we need for navigation.
    const { notebooks } = await apiGet('/api/notebooks');
    const algoNb = notebooks.find((nb) => /algorithm/i.test(nb.name)) ?? notebooks[0];
    if (!algoNb) throw new Error('no seeded notebook found — did the seed run correctly?');
    const { results: bigOResults } = await apiGet(`/api/search/titles?q=${encodeURIComponent('Big-O')}&limit=5`);
    const bigONote = bigOResults[0];
    if (!bigONote) throw new Error('seeded "Big-O" note not found via /api/search/titles');

    browser = await chromium.launch();

    // ---- Desktop phase -----------------------------------------------------
    const desktopCtx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      colorScheme: 'light',
    });
    const page = await desktopCtx.newPage();
    attachConsoleCapture(page);

    mark('dashboard (light)');
    await page.goto(`${BASE_URL}/`, { waitUntil: 'load' });
    await setTheme(page, 'light');
    await page.waitForSelector('[data-testid="dashboard-stats"]', { timeout: 15_000 });

    await shot('01-dashboard-light.png', async () => {
      await page.screenshot({ path: path.join(OUT_DIR, '01-dashboard-light.png'), fullPage: true });
    });

    mark('dashboard (dark)');
    await shot('02-dashboard-dark.png', async () => {
      await setTheme(page, 'dark');
      await page.waitForSelector('[data-testid="dashboard-stats"]', { timeout: 15_000 });
      await page.screenshot({ path: path.join(OUT_DIR, '02-dashboard-dark.png'), fullPage: true });
    });
    await setTheme(page, 'light');

    mark('notebook page');
    await shot('03-notebook-page.png', async () => {
      await page.goto(`${BASE_URL}/notebook/${algoNb.id}`, { waitUntil: 'load' });
      await page.waitForSelector('.note-list, .nb-page__title', { timeout: 15_000 });
      await page.waitForSelector('.note-card', { timeout: 15_000 });
      await page.screenshot({ path: path.join(OUT_DIR, '03-notebook-page.png'), fullPage: true });
    });

    mark('note editor (Big-O)');
    await shot('04-editor-note.png', async () => {
      await page.goto(`${BASE_URL}/note/${bigONote.id}`, { waitUntil: 'load' });
      await page.waitForSelector('[data-testid="note-editor"]', { timeout: 15_000 });
      await page.waitForSelector('.folio-prosemirror h1', { timeout: 15_000 });
      await page.screenshot({ path: path.join(OUT_DIR, '04-editor-note.png'), fullPage: true });
    });

    // Let in-flight async state settle (unlinkedMentions/aiHealth/studyStats fetches
    // from the note/sidebar can resolve a beat late after several rapid navigations).
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
    await sleep(300);

    // Set up a scratch paragraph at the end of a plain <p> block (not a list —
    // avoids list-exit keymap edge cases) for the slash/wikilink menu demos,
    // then clean it back up so the note is unchanged for later shots.
    //
    // This is verify-and-retry rather than a single click+End+Enter: a late-resolving
    // async effect on the note page (unlinkedMentions/aiHealth) can occasionally call
    // editor.commands.focus('start') right as we're navigating the caret, which snaps
    // the cursor back to the very start of the document (confirmed via repro — it only
    // ever *repositions* the cursor, it never mutates content by itself). We verify the
    // cursor actually landed in a fresh empty paragraph BEFORE typing anything, and
    // retry the click if not, so we never type into the wrong place.
    const scratchParagraph = page
      .locator('.folio-prosemirror p')
      .filter({ hasText: 'Recursive algorithms often have hidden' });
    let scratchReady = false;
    try {
      await scratchParagraph.waitFor({ state: 'visible', timeout: 10_000 });
      for (let attempt = 1; attempt <= 8 && !scratchReady; attempt++) {
        const box = await scratchParagraph.boundingBox();
        if (!box) throw new Error('scratch paragraph has no bounding box');
        // Click near the end of the paragraph's own box (not raw page coordinates —
        // this note is long, the paragraph starts out scrolled off-screen, and
        // locator.click() auto-scrolls it into view before resolving the position).
        // Small gaps between each key action give ProseMirror's own transaction
        // dispatch (incl. the UniqueID plugin's appendTransaction) time to settle
        // before the next input — the observed misfire is a same-tick race, not a
        // slow one, so this is cheap insurance on top of the verify-and-retry.
        await scratchParagraph.click({ position: { x: Math.max(box.width - 4, 1), y: Math.max(box.height - 4, 1) } });
        await sleep(150);
        await page.keyboard.press('End');
        await sleep(150);
        await page.keyboard.press('Enter');
        await sleep(150);
        if (await caretInEmptyEditorBlock(page)) {
          scratchReady = true;
        } else {
          warn(`scratch paragraph setup landed unexpectedly (attempt ${attempt}) — retrying`);
          await sleep(400);
        }
      }
      if (!scratchReady) throw new Error('could not reliably focus an empty scratch paragraph after retries');
    } catch (e) {
      warn(`could not prepare scratch paragraph for slash/wikilink demos: ${e.message}`);
    }

    mark('note editor — slash menu');
    await shot('05-editor-slash-menu.png', async () => {
      if (!scratchReady) throw new Error('scratch paragraph unavailable');
      await page.keyboard.type('/', { delay: 15 });
      await page.waitForSelector('[data-testid="slash-menu"]', { timeout: 5_000 });
      await page.screenshot({ path: path.join(OUT_DIR, '05-editor-slash-menu.png') });
    });
    if (scratchReady) {
      await page.keyboard.press('Escape').catch(() => {});
      await page.keyboard.press('Backspace').catch(() => {});
    }

    mark('note editor — wikilink menu');
    await shot('06-editor-wikilink-menu.png', async () => {
      if (!scratchReady) throw new Error('scratch paragraph unavailable');
      if (!(await caretInEmptyEditorBlock(page))) throw new Error('caret drifted away from the scratch paragraph before the wikilink demo');
      await page.keyboard.type('[[', { delay: 15 });
      await page.keyboard.type('B', { delay: 15 });
      await page.waitForSelector('[data-testid="wikilink-menu"]', { timeout: 5_000 });
      await page.screenshot({ path: path.join(OUT_DIR, '06-editor-wikilink-menu.png') });
    });
    if (scratchReady) {
      await page.keyboard.press('Escape').catch(() => {});
      await page.keyboard.press('Backspace').catch(() => {});
      await page.keyboard.press('Backspace').catch(() => {});
      await page.keyboard.press('Backspace').catch(() => {});
      // Remove the scratch paragraph itself, merging back into the previous one.
      await page.keyboard.press('Backspace').catch(() => {});
    }

    mark('note editor — selection toolbar');
    await shot('07-editor-selection-toolbar.png', async () => {
      const firstPara = page.locator('.folio-prosemirror p').first();
      await firstPara.waitFor({ state: 'visible', timeout: 10_000 });
      // Retry the triple-click: the same rare ProseMirror selection-mapping race that
      // can hit the scratch-paragraph setup can also collapse this selection right
      // after it's made, which would hide the bubble menu before we can shoot it.
      let bubbleVisible = false;
      for (let attempt = 1; attempt <= 4 && !bubbleVisible; attempt++) {
        await firstPara.click({ clickCount: 3 });
        bubbleVisible = await page
          .waitForSelector('.folio-selection-bubble', { timeout: 3_000 })
          .then(() => true)
          .catch(() => false);
        if (!bubbleVisible) await sleep(400);
      }
      if (!bubbleVisible) throw new Error('selection bubble never appeared after retries');
      await page.screenshot({ path: path.join(OUT_DIR, '07-editor-selection-toolbar.png') });
    });
    await page.keyboard.press('ArrowRight').catch(() => {});

    mark('note editor — history drawer');
    await shot('08-editor-history-panel.png', async () => {
      await page.getByRole('button', { name: 'History', exact: true }).click();
      await page.waitForSelector('[data-testid="history-drawer"]', { timeout: 10_000 });
      await page.waitForSelector('[data-testid="history-version-item"]', { timeout: 10_000 });
      await page.screenshot({ path: path.join(OUT_DIR, '08-editor-history-panel.png') });
    });
    await page.getByRole('button', { name: 'Close history' }).click().catch(() => {});

    mark('note editor (dark)');
    await shot('09-editor-dark.png', async () => {
      await setTheme(page, 'dark');
      await page.waitForSelector('[data-testid="note-editor"]', { timeout: 15_000 });
      await page.waitForSelector('.folio-prosemirror h1', { timeout: 15_000 });
      await page.screenshot({ path: path.join(OUT_DIR, '09-editor-dark.png'), fullPage: true });
    });
    await setTheme(page, 'light');

    mark('quick switcher');
    await shot('10-quick-switcher.png', async () => {
      await page.goto(`${BASE_URL}/`, { waitUntil: 'load' });
      await page.waitForSelector('[data-testid="dashboard-stats"]', { timeout: 15_000 });
      await page.keyboard.press('Control+k');
      await page.waitForSelector('[data-testid="quick-switcher"]', { timeout: 5_000 });
      await page.locator('[data-testid="quick-switcher"] input').click();
      await page.keyboard.type('Big', { delay: 20 });
      await page.waitForSelector('[data-testid="quick-switcher-result"]', { timeout: 5_000 });
      await page.screenshot({ path: path.join(OUT_DIR, '10-quick-switcher.png') });
    });
    await page.keyboard.press('Escape').catch(() => {});

    mark('study — review question');
    await shot('11-study-review.png', async () => {
      await page.goto(`${BASE_URL}/study`, { waitUntil: 'load' });
      await page.waitForSelector('.sy-review-card__question', { timeout: 15_000 });
      await page.screenshot({ path: path.join(OUT_DIR, '11-study-review.png'), fullPage: true });
    });

    mark('study — answer + ratings');
    await shot('12-study-answer.png', async () => {
      await page.getByRole('button', { name: /show answer/i }).click();
      await page.waitForSelector('.sy-review-card.is-revealed', { timeout: 10_000 });
      await page.waitForSelector('.sy-rating-btn:not([disabled])', { timeout: 10_000 });
      await page.screenshot({ path: path.join(OUT_DIR, '12-study-answer.png'), fullPage: true });
    });

    mark('ask page (empty)');
    await shot('13-ask-page.png', async () => {
      await page.goto(`${BASE_URL}/ask`, { waitUntil: 'load' });
      await page.waitForSelector('text=Ask your notes', { timeout: 15_000 });
      await page.screenshot({ path: path.join(OUT_DIR, '13-ask-page.png'), fullPage: true });
    });

    mark('import modal (photo tab)');
    await shot('14-import-modal.png', async () => {
      await page.goto(`${BASE_URL}/notebook/${algoNb.id}`, { waitUntil: 'load' });
      await page.waitForSelector('.note-card', { timeout: 15_000 });
      await page.getByRole('button', { name: 'Import notes' }).click();
      await page.getByRole('menuitem', { name: /photo of notes/i }).click();
      const dialog = page.getByRole('dialog', { name: 'Import' });
      await dialog.waitFor({ state: 'visible', timeout: 10_000 });
      await page.waitForSelector('.im-tab.is-active', { timeout: 5_000 });
      await page.screenshot({ path: path.join(OUT_DIR, '14-import-modal.png') });
    });
    await page.getByRole('button', { name: 'Cancel' }).click().catch(() => {});

    // ---- Mobile phase --------------------------------------------------------
    const mobileCtx = await browser.newContext({ ...devices['Pixel 7'], colorScheme: 'light' });
    const mobilePage = await mobileCtx.newPage();
    attachConsoleCapture(mobilePage);

    mark('capture (mobile)');
    await shot('15-capture-mobile.png', async () => {
      await mobilePage.goto(`${BASE_URL}/capture`, { waitUntil: 'load' });
      await mobilePage.waitForSelector('text=Capture a page in seconds', { timeout: 15_000 });
      await mobilePage.waitForSelector('.cp-notebooks .im-chip, .cp-notebooks__hint', { timeout: 15_000 });
      await mobilePage.screenshot({ path: path.join(OUT_DIR, '15-capture-mobile.png'), fullPage: true });
    });

    mark('dashboard (mobile, drawer closed)');
    await shot('16-dashboard-mobile.png', async () => {
      await mobilePage.goto(`${BASE_URL}/`, { waitUntil: 'load' });
      await mobilePage.waitForSelector('[data-testid="dashboard-stats"]', { timeout: 15_000 });
      await mobilePage.screenshot({ path: path.join(OUT_DIR, '16-dashboard-mobile.png'), fullPage: true });
    });

    mark('mobile drawer (open)');
    await shot('17-mobile-drawer.png', async () => {
      await mobilePage.getByRole('button', { name: 'Open menu' }).click();
      await mobilePage.waitForSelector('.app-sidebar-wrap[data-mobile-open="true"]', { timeout: 5_000 });
      await mobilePage.getByRole('navigation', { name: 'Folio' }).waitFor({ state: 'visible', timeout: 5_000 });
      await mobilePage.screenshot({ path: path.join(OUT_DIR, '17-mobile-drawer.png') });
    });

    await mobileCtx.close();

    // ---- Back to desktop for the final dark shot -----------------------------
    mark('notebook page (dark)');
    await shot('18-notebook-dark.png', async () => {
      await setTheme(page, 'dark');
      await page.waitForSelector('.note-card', { timeout: 15_000 });
      await page.screenshot({ path: path.join(OUT_DIR, '18-notebook-dark.png'), fullPage: true });
    });

    await desktopCtx.close();
  } finally {
    if (browser) await browser.close().catch(() => {});
    killServerTree(serverProc);
  }

  // ---- Console report ---------------------------------------------------
  const byPage = new Map();
  for (const ev of consoleEvents) {
    if (!byPage.has(ev.page)) byPage.set(ev.page, { page: ev.page, errors: [], warnings: [], pageerrors: [] });
    const bucket = byPage.get(ev.page);
    if (ev.type === 'error') bucket.errors.push(ev.text);
    else if (ev.type === 'warning') bucket.warnings.push(ev.text);
    else bucket.pageerrors.push(ev.text);
  }
  const report = Array.from(byPage.values());
  fs.writeFileSync(path.join(OUT_DIR, '00-console-report.json'), JSON.stringify(report, null, 2));

  // ---- Summary ------------------------------------------------------------
  log('---- summary ----');
  for (const s of shots) {
    if (s.status === 'ok') log(`  OK    ${s.name} (${s.bytes} bytes)`);
    else log(`  FAIL  ${s.name} — ${s.reason}`);
  }
  const failed = shots.filter((s) => s.status !== 'ok');
  const totalConsoleIssues = consoleEvents.length;
  log(`${shots.length - failed.length}/${shots.length} shots captured, ${failed.length} skipped, ${totalConsoleIssues} console issue(s) recorded across ${report.length} page(s).`);
  if (failed.length > 0) {
    log('Skipped shots (non-fatal):');
    for (const s of failed) log(`  - ${s.name}: ${s.reason}`);
  }
}

main().catch((e) => {
  console.error('[review-pack] FATAL:', e);
  process.exitCode = 1;
});
