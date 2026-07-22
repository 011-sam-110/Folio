import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './auth.fixture';
import { apiCreateNotebook, exact, skipIfUpstreamQuota, uniqueName } from './utils';

// See import.spec.ts - `__dirname` is not defined in this ESM repo.
const FIXTURES_DIR = fileURLToPath(new URL('fixtures', import.meta.url));

// Selectors are matched against CapturePage.tsx's real DOM
// (web/src/features/import/CapturePage.tsx):
//   • kind switch - role="tablist", items are role="tab"
//   • notebook chips - role="radiogroup", items are role="radio". These used to be
//     plain buttons in a tablist; the owning agent corrected that (a tablist with no
//     tabpanels is a lie, and "pick exactly one" is what radiogroup means), so the
//     selectors here follow.
//   • the big CTA is a `.cp-cta` button
//   • success is a "Note ready" heading with `.cp-success__title` + an "Open note" link

/**
 * Waits for a capture job to reach a terminal state, whichever it is.
 *
 * Racing the success heading against the error banner means a failed job is
 * diagnosed immediately with the server's own message instead of burning the full
 * 90s budget and then reporting only "heading not found".
 */
async function settleCapture(page: import('@playwright/test').Page, successHeading: RegExp) {
  const success = page.getByRole('heading', { name: successHeading });
  const errorBanner = page.locator('.cp-error');
  await expect(success.or(errorBanner)).toBeVisible({ timeout: 90_000 });
  if (await errorBanner.isVisible().catch(() => false)) {
    const detail = await errorBanner.locator('p').first().textContent().catch(() => null);
    skipIfUpstreamQuota(detail);
    throw new Error(`Mobile capture failed: ${detail ?? '(no error detail rendered)'}`);
  }
}

test.describe('Mobile capture page (Pixel 7)', () => {
  test('renders a big capture button and scrollable notebook chips', async ({ page, request }) => {
    await apiCreateNotebook(request, uniqueName('E2E Mobile Chip A'));
    await apiCreateNotebook(request, uniqueName('E2E Mobile Chip B'));
    await apiCreateNotebook(request, uniqueName('E2E Mobile Chip C'));

    await page.goto('/capture');

    // Default kind is "photo" - CTA label is "Photo of notes".
    const captureButton = page.getByRole('button', { name: /photo of notes|capture|take photo|camera/i });
    await expect(captureButton.first()).toBeVisible({ timeout: 10_000 });

    const notebookChips = page.getByRole('radio', { name: /E2E Mobile Chip/ });
    await expect(notebookChips.first()).toBeVisible({ timeout: 10_000 });
    expect(await notebookChips.count()).toBeGreaterThanOrEqual(2);
  });

  test('a transcript capture completes end-to-end and shows a success card with the note title', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const notebook = await apiCreateNotebook(request, uniqueName('E2E Mobile Capture Notebook'));

    await page.goto('/capture');

    const notebookChip = page.getByRole('radio', { name: exact(notebook.name) });
    await notebookChip.first().click();

    // Kind switch to transcript ("Transcript or essay").
    await page.getByRole('tab', { name: /transcript/i }).click();

    await page.locator('input[type="file"]').first().setInputFiles(path.join(FIXTURES_DIR, 'transcript.txt'));

    await page.getByRole('button', { name: /upload.*process/i }).click();

    await settleCapture(page, /note ready/i);

    const title = page.locator('.cp-success__title');
    await expect(title).toBeVisible({ timeout: 5_000 });
    const text = (await title.textContent()) ?? '';
    expect(text.trim().length).toBeGreaterThan(0);

    await expect(page.getByRole('link', { name: /open note/i })).toBeVisible();
  });

  test('"Add another page" chains a second capture into the SAME note (multi-page session)', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const notebook = await apiCreateNotebook(request, uniqueName('E2E Capture Chain Notebook'));

    await page.goto('/capture');
    await page.getByRole('radio', { name: exact(notebook.name) }).first().click();
    await page.getByRole('tab', { name: /transcript/i }).click();

    // Page 1: the deadlocks transcript.
    await page.locator('input[type="file"]').first().setInputFiles(path.join(FIXTURES_DIR, 'transcript.txt'));
    await page.getByRole('button', { name: /upload.*process/i }).click();
    await settleCapture(page, /note ready/i);

    const firstNoteHref = await page.getByRole('link', { name: /open note/i }).getAttribute('href');
    const firstNoteId = firstNoteHref?.match(/\/note\/([^/?#]+)/)?.[1];
    expect(firstNoteId).toBeTruthy();

    // Chain: "Add another page" must append into the note just created, not start a new one.
    await page.getByRole('button', { name: /add another page/i }).click();
    await expect(page.getByTestId('capture-append-banner')).toBeVisible({ timeout: 5_000 });

    // Page 2: the testing-pyramid docx (same transcript kind accepts .docx).
    await page.locator('input[type="file"]').first().setInputFiles(path.join(FIXTURES_DIR, 'essay.docx'));
    await page.getByRole('button', { name: /upload.*add to note/i }).click();
    await settleCapture(page, /page added/i);

    // Same note id, and the note now contains material from BOTH pages.
    const secondHref = await page.getByRole('link', { name: /open note/i }).getAttribute('href');
    expect(secondHref).toBe(firstNoteHref);
    const res = await request.get(`/api/notes/${firstNoteId}`);
    expect(res.ok()).toBeTruthy();
    const { note } = await res.json();
    expect(note.contentText).toMatch(/deadlock/i);
    expect(note.contentText).toMatch(/testing pyramid|unit test/i);
  });
});
