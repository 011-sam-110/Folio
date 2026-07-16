import path from 'node:path';
import { expect, test } from '@playwright/test';
import { apiCreateNotebook, editorBody, runDesktopImport, uniqueName } from './utils';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

test.describe.configure({ mode: 'serial' });

test.describe('Import (ImportModal)', () => {
  test('transcript.txt imports into a new note with headings', async ({ page, request }) => {
    test.setTimeout(120_000);
    const notebook = await apiCreateNotebook(request, uniqueName('E2E Import Transcript Notebook'));
    await page.goto(`/notebook/${notebook.id}`);

    await runDesktopImport(page, {
      kindLabel: /transcript/i,
      filePath: path.join(FIXTURES_DIR, 'transcript.txt'),
      notebookName: notebook.name,
      doneTimeout: 90_000,
    });

    await expect(page.getByPlaceholder('Untitled')).not.toHaveValue('', { timeout: 10_000 });
    await expect(editorBody(page).locator('h1, h2, h3').first()).toBeVisible({ timeout: 10_000 });
  });

  test('slides.pdf imports and the resulting note mentions JOIN', async ({ page, request }) => {
    test.setTimeout(120_000);
    const notebook = await apiCreateNotebook(request, uniqueName('E2E Import Slides Notebook'));
    await page.goto(`/notebook/${notebook.id}`);

    await runDesktopImport(page, {
      kindLabel: /slides/i,
      filePath: path.join(FIXTURES_DIR, 'slides.pdf'),
      notebookName: notebook.name,
      doneTimeout: 90_000,
    });

    const body = editorBody(page);
    await expect
      .poll(async () => body.textContent({ timeout: 3_000 }).catch(() => ''), { timeout: 60_000 })
      .toMatch(/join/i);
  });

  test('note-photo.png imports via vision OCR and the note mentions scheduling', async ({ page, request }) => {
    test.setTimeout(180_000);
    const notebook = await apiCreateNotebook(request, uniqueName('E2E Import Photo Notebook'));
    await page.goto(`/notebook/${notebook.id}`);

    await runDesktopImport(page, {
      kindLabel: /photo/i,
      filePath: path.join(FIXTURES_DIR, 'note-photo.png'),
      notebookName: notebook.name,
      doneTimeout: 150_000,
    });

    const body = editorBody(page);
    await expect
      .poll(async () => body.textContent({ timeout: 3_000 }).catch(() => ''), { timeout: 90_000 })
      .toMatch(/scheduling/i);
  });
});
