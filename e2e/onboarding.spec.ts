/**
 * The guided tutorial, first-run hints and shortcut cheatsheet.
 *
 * Every other spec in this suite starts from a storageState that marks the tutorial
 * already answered (see markOnboardingSeen in auth.fixture.ts) — otherwise the
 * modal coach mark would block them all. This file is the one that deliberately
 * clears that record, so it is the only place the first-run experience is exercised.
 *
 * What is worth asserting here is not the copy, which will change, but the two
 * properties the feature has to hold: it can always be left, and it never points at
 * nothing. The second is checked by walking the tour on an account with NO example
 * content, where five of the ten steps have no target to find — a run that has to
 * end at "closed", not at a highlight over an empty region.
 */
import { test, expect, freshAccount } from './auth.fixture';
import { sidebarNav } from './utils';
import type { Page } from '@playwright/test';

const ONBOARDING_PREFIX = 'folio:onboarding:v1:';

/** Puts the browser back into the state a brand-new account is in. */
async function clearOnboarding(page: Page): Promise<void> {
  await page.evaluate((prefix) => {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith(prefix)) localStorage.removeItem(k);
    }
  }, ONBOARDING_PREFIX);
}

async function readOnboarding(page: Page): Promise<{ status: string; hints: Record<string, true> } | null> {
  return page.evaluate((prefix) => {
    const key = Object.keys(localStorage).find((k) => k.startsWith(prefix));
    return key ? JSON.parse(localStorage.getItem(key)!) : null;
  }, ONBOARDING_PREFIX);
}

const tourCard = (page: Page) => page.getByTestId('tour-card');

test.describe('onboarding tutorial', () => {
  test('auto-opens once for a new account and can be declined for good', async ({ page }) => {
    await page.goto('/');
    await expect(sidebarNav(page)).toBeVisible();
    await clearOnboarding(page);
    await page.reload();

    await expect(tourCard(page)).toBeVisible({ timeout: 10_000 });
    await expect(tourCard(page)).toContainText('Welcome to Unote');

    // The seed offer must be optional and readable as such.
    await expect(page.getByRole('button', { name: /use my own notes/i })).toBeVisible();

    await page.getByRole('button', { name: /not now/i }).click();
    await expect(tourCard(page)).toBeHidden();
    expect((await readOnboarding(page))?.status).toBe('skipped');

    // Declined means declined: it must not come back on the next visit.
    await page.reload();
    await expect(sidebarNav(page)).toBeVisible();
    await expect(tourCard(page)).toBeHidden();
  });

  test('Escape leaves the tour resumable rather than dismissing it for good', async ({ page }) => {
    await page.goto('/');
    await expect(sidebarNav(page)).toBeVisible();
    await clearOnboarding(page);
    await page.reload();

    await expect(tourCard(page)).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press('Escape');
    await expect(tourCard(page)).toBeHidden();

    // 'paused', not 'skipped' — the difference is what makes it offer to resume.
    expect((await readOnboarding(page))?.status).toBe('paused');

    // Focus must not be left on <body>, which would strand a keyboard user at the
    // very top of the document.
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
  });

  test('walks to the end without the example notebook, skipping steps that have no target', async ({ page }) => {
    await page.goto('/');
    await expect(sidebarNav(page)).toBeVisible();
    await clearOnboarding(page);
    await page.reload();

    await expect(tourCard(page)).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: /use my own notes/i }).click();

    // Five of the ten steps depend on seeded content this account does not have.
    // The tour must still terminate — bounded by the step count, not by a timeout.
    for (let i = 0; i < TOUR_STEPS_MAX_CLICKS; i++) {
      if (!(await tourCard(page).isVisible().catch(() => false))) break;
      const next = page.getByRole('button', { name: /^(Next|Finish)$/ });
      if (!(await next.isVisible().catch(() => false))) break;
      await next.click();
      // Give a skipped step its resolve window before looking again.
      await page.waitForTimeout(400);
    }

    await expect(tourCard(page)).toBeHidden({ timeout: 20_000 });
    expect((await readOnboarding(page))?.status).toBe('done');
  });

  test('is re-runnable from the account menu after being finished', async ({ page }) => {
    await page.goto('/');
    await expect(sidebarNav(page)).toBeVisible();

    await page.locator('.sidebar-account__trigger').click();
    await page.getByRole('menuitem', { name: /take the tutorial/i }).click();

    await expect(tourCard(page)).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press('Escape');
  });

  test('the tour card is a real dialog: labelled, focus-trapped, Escape-closable', async ({ page }) => {
    await page.goto('/');
    await expect(sidebarNav(page)).toBeVisible();
    await clearOnboarding(page);
    await page.reload();

    const card = tourCard(page);
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toHaveAttribute('role', 'dialog');
    await expect(card).toHaveAttribute('aria-modal', 'true');

    // Named by its own visible heading, not a duplicated aria-label.
    const labelledBy = await card.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    await expect(page.locator(`#${labelledBy}`)).toBeVisible();

    // Focus starts on the primary action, so Enter alone advances the tour.
    expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toMatch(
      /Add example|Start the tour/,
    );

    // Tab must not escape into the page behind.
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(
        () => !!document.querySelector('[data-testid="tour-card"]')?.contains(document.activeElement),
      );
      expect(inside).toBe(true);
    }
  });
});

test.describe('contextual help', () => {
  test('the shortcut cheatsheet opens with ? and closes with Escape', async ({ page }) => {
    await page.goto('/');
    await expect(sidebarNav(page)).toBeVisible();

    await page.keyboard.press('?');
    const sheet = page.getByTestId('shortcuts-sheet');
    await expect(sheet).toBeVisible();
    // A binding that actually exists, listed against the key that fires it.
    await expect(sheet).toContainText('Command palette');

    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  });

  test('? does nothing while typing, because it is a real character', async ({ page, request }) => {
    const { notebook } = await (await request.post('/api/notebooks', { data: { name: 'Q', emoji: '❓' } })).json();
    const { note } = await (await request.post('/api/notes', { data: { notebookId: notebook.id } })).json();

    await page.goto(`/note/${note.id}`);
    const body = page.getByTestId('note-editor');
    await expect(body).toBeVisible({ timeout: 10_000 });
    await body.click();
    await page.keyboard.type('why? because.');

    await expect(page.getByTestId('shortcuts-sheet')).toBeHidden();
    await expect(body).toContainText('why? because.');
  });

  test('a dismissed hint stays dismissed across a reload', async ({ page }) => {
    await page.goto('/search');
    // The fixture pre-dismisses every hint so unrelated specs stay quiet; re-arm
    // them here, keeping the 'skipped' tutorial status that makes hints eligible.
    await page.evaluate((prefix) => {
      const key = Object.keys(localStorage).find((k) => k.startsWith(prefix))!;
      const state = JSON.parse(localStorage.getItem(key)!);
      localStorage.setItem(key, JSON.stringify({ ...state, hints: {} }));
    }, ONBOARDING_PREFIX);
    await page.reload();

    const hint = page.getByTestId('hint-bubble');
    await expect(hint).toBeVisible({ timeout: 15_000 });
    const hintId = await hint.getAttribute('data-hint-id');

    await hint.getByRole('button', { name: /got it/i }).click();
    await expect(hint).toBeHidden();

    const stored = await readOnboarding(page);
    expect(stored?.hints?.[hintId!]).toBe(true);

    await page.reload();
    await page.waitForTimeout(4000); // well past the hint's settle window
    await expect(page.getByTestId('hint-bubble')).toBeHidden();
  });
});

test.describe('teaching empty states', () => {
  test('a vault with no notes offers the actions that fill it', async ({ browser, baseURL }) => {
    // A pristine account: the shared worker account has notes from other specs.
    const { account, api } = await freshAccount(baseURL!, 'empty-state');
    try {
      const context = await browser.newContext({ storageState: account.storageStatePath });
      const page = await context.newPage();
      await page.goto('/');

      const main = page.getByRole('main');
      await expect(main.getByText(/your notes will show up here/i)).toBeVisible({ timeout: 15_000 });
      // The point of the change: it names a way out of the empty state.
      await expect(main.getByRole('button', { name: /write a note/i })).toBeVisible();
      await expect(main.getByRole('button', { name: /import slides or a pdf/i })).toBeVisible();

      await main.getByRole('button', { name: /write a note/i }).click();
      await page.waitForURL(/\/note\//);
      await context.close();
    } finally {
      await api.dispose();
    }
  });
});

/** Ten steps, plus slack for the welcome card and any that resolve slowly. */
const TOUR_STEPS_MAX_CLICKS = 16;
