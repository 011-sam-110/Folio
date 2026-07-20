import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './auth.fixture';
import { apiCreateNotebook, editorBody, runDesktopImport, uniqueName } from './utils';

// The repo is ESM ("type": "module" in the root package.json, set so Vercel compiles
// api/index.ts as an ES module), so `__dirname` does not exist here — referencing it
// threw at module load and took the WHOLE suite down, not just this file.
const FIXTURES_DIR = fileURLToPath(new URL('fixtures', import.meta.url));

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

  test('slides.pptx imports end-to-end and the note mentions normalisation', async ({ page, request }) => {
    test.setTimeout(120_000);
    const notebook = await apiCreateNotebook(request, uniqueName('E2E Import PPTX Notebook'));
    await page.goto(`/notebook/${notebook.id}`);

    await runDesktopImport(page, {
      kindLabel: /slides/i,
      filePath: path.join(FIXTURES_DIR, 'slides.pptx'),
      notebookName: notebook.name,
      doneTimeout: 90_000,
    });

    const body = editorBody(page);
    await expect
      .poll(async () => body.textContent({ timeout: 3_000 }).catch(() => ''), { timeout: 60_000 })
      .toMatch(/normalisation|normal form/i);
  });

  test('essay.docx imports end-to-end, mentions the testing pyramid, and shows the original in the attachment strip', async ({ page, request }) => {
    test.setTimeout(120_000);
    const notebook = await apiCreateNotebook(request, uniqueName('E2E Import DOCX Notebook'));
    await page.goto(`/notebook/${notebook.id}`);

    await runDesktopImport(page, {
      kindLabel: /transcript/i,
      filePath: path.join(FIXTURES_DIR, 'essay.docx'),
      notebookName: notebook.name,
      doneTimeout: 90_000,
    });

    const body = editorBody(page);
    await expect
      .poll(async () => body.textContent({ timeout: 3_000 }).catch(() => ''), { timeout: 60_000 })
      .toMatch(/testing pyramid|unit test/i);

    // "Never destructive OCR": the original .docx is one click away under the title.
    const attachment = page.locator('.folio-attachment');
    await expect(attachment.first()).toBeVisible({ timeout: 10_000 });
    await expect(attachment.first()).toContainText(/essay\.docx/i);
    const href = await attachment.first().getAttribute('href');
    expect(href).toMatch(/^\/uploads\//);
    const download = await request.get(href!);
    expect(download.ok()).toBeTruthy();
  });

  test('note-photo.png imports via vision OCR and the note mentions scheduling', async ({ page, request }) => {
    test.setTimeout(180_000);
    const notebook = await apiCreateNotebook(request, uniqueName('E2E Import Photo Notebook'));
    await page.goto(`/notebook/${notebook.id}`);

    try {
      await runDesktopImport(page, {
        kindLabel: /photo/i,
        filePath: path.join(FIXTURES_DIR, 'note-photo.png'),
        notebookName: notebook.name,
        doneTimeout: 150_000,
      });
    } catch (err) {
      // The free gateway's VISION pool is burst/day rate-limited upstream. When every
      // vision model is exhausted this is an external quota condition, not an app bug —
      // the app correctly surfaces the failure with a Retry. Skip (loudly) rather than
      // fail so quota droughts don't mask real regressions elsewhere in the suite.
      const msg = err instanceof Error ? err.message : String(err);
      test.skip(/All AI models failed/i.test(msg), `vision providers rate-limited upstream: ${msg}`);
      throw err;
    }

    const body = editorBody(page);
    await expect
      .poll(async () => body.textContent({ timeout: 3_000 }).catch(() => ''), { timeout: 90_000 })
      .toMatch(/scheduling/i);
  });
});
