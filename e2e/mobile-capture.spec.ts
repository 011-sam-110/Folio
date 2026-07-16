import path from 'node:path';
import { expect, test } from '@playwright/test';
import { apiCreateNotebook, exact, uniqueName } from './utils';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

// CapturePage.tsx (web/src/features/import/CapturePage.tsx) already exists with real
// markup at the time this suite was written, so these selectors are matched against
// its actual DOM rather than guessed: kind switch + notebook chips are
// role="tablist" containers (kind items are role="tab", notebook chips are plain
// buttons), the big CTA is a `.cp-cta` button, and success is an
// "Note ready" heading with a `.cp-success__title` paragraph + an "Open note" link.

test.describe('Mobile capture page (Pixel 7)', () => {
  test('renders a big capture button and scrollable notebook chips', async ({ page, request }) => {
    await apiCreateNotebook(request, uniqueName('E2E Mobile Chip A'));
    await apiCreateNotebook(request, uniqueName('E2E Mobile Chip B'));
    await apiCreateNotebook(request, uniqueName('E2E Mobile Chip C'));

    await page.goto('/capture');

    // Default kind is "photo" — CTA label is "Photo of notes".
    const captureButton = page.getByRole('button', { name: /photo of notes|capture|take photo|camera/i });
    await expect(captureButton.first()).toBeVisible({ timeout: 10_000 });

    const notebookChips = page.getByRole('button', { name: /E2E Mobile Chip/ });
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

    const notebookChip = page.getByRole('button', { name: exact(notebook.name) });
    await notebookChip.first().click();

    // Kind switch to transcript ("Transcript or essay").
    await page.getByRole('tab', { name: /transcript/i }).click();

    await page.locator('input[type="file"]').first().setInputFiles(path.join(FIXTURES_DIR, 'transcript.txt'));

    await page.getByRole('button', { name: /upload.*process/i }).click();

    const successHeading = page.getByRole('heading', { name: /note ready/i });
    const errorBanner = page.locator('.cp-error');
    await expect(successHeading.or(errorBanner)).toBeVisible({ timeout: 90_000 });
    if (await errorBanner.isVisible().catch(() => false)) {
      const detail = await errorBanner.locator('p').first().textContent().catch(() => null);
      throw new Error(`Mobile capture failed: ${detail ?? '(no error detail rendered)'}`);
    }

    const title = page.locator('.cp-success__title');
    await expect(title).toBeVisible({ timeout: 5_000 });
    const text = (await title.textContent()) ?? '';
    expect(text.trim().length).toBeGreaterThan(0);

    await expect(page.getByRole('link', { name: /open note/i })).toBeVisible();
  });
});
