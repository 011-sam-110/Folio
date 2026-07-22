import { expect, test } from './auth.fixture';
import {
  TESTIDS,
  createNoteViaButton,
  createNotebookViaSidebar,
  openNotebook,
  openQuickSwitcher,
  quickSwitcherInput,
  setNoteTitle,
  typeInEditor,
  uniqueName,
  waitForSaved,
} from './utils';

// The seed database is not inspectable at the time this suite was written (it's
// built by a parallel agent), so per the task's fallback instructions these specs
// create their own known-content notes rather than assuming specific seeded titles.

test.describe('Search', () => {
  test('Ctrl+K quick switcher: title match navigates to the note', async ({ page }) => {
    const notebookName = uniqueName('E2E Search Notebook');
    const noteTitle = uniqueName('Balanced B-tree Indexing');

    await page.goto('/');
    await createNotebookViaSidebar(page, notebookName);
    await openNotebook(page, notebookName);
    await createNoteViaButton(page);
    await setNoteTitle(page, noteTitle);
    await typeInEditor(page, 'A B-tree keeps its data sorted and allows logarithmic-time lookups.');
    await waitForSaved(page);

    await page.goto('/');
    await openQuickSwitcher(page);
    await quickSwitcherInput(page).fill('B-tree Indexing');

    const result = page.getByTestId(TESTIDS.quickSwitcherResult).filter({ hasText: noteTitle }).first();
    await expect(result).toBeVisible({ timeout: 10_000 });
    await result.click();

    await page.waitForURL(/\/note\//, { timeout: 10_000 });
    await expect(page.getByPlaceholder('Untitled')).toHaveValue(noteTitle, { timeout: 10_000 });
  });

  test('full-text section shows a highlighted <mark> snippet for a body match', async ({ page }) => {
    const notebookName = uniqueName('E2E Fulltext Notebook');
    const noteTitle = uniqueName('Revision Page');
    const rareTerm = `zephyrindex${Date.now()}`;

    await page.goto('/');
    await createNotebookViaSidebar(page, notebookName);
    await openNotebook(page, notebookName);
    await createNoteViaButton(page);
    await setNoteTitle(page, noteTitle);
    await typeInEditor(page, `This paragraph is only findable by the rare term ${rareTerm} buried in the body.`);
    await waitForSaved(page);

    await page.goto('/');
    await openQuickSwitcher(page);
    await quickSwitcherInput(page).fill(rareTerm);

    const fulltext = page.getByTestId(TESTIDS.fulltextResults);
    await expect(fulltext).toBeVisible({ timeout: 10_000 });
    await expect(fulltext.locator('mark').filter({ hasText: new RegExp(rareTerm, 'i') })).toBeVisible();
  });

  test('a hostile query does not error or crash the palette', async ({ page }) => {
    await page.goto('/');
    await openQuickSwitcher(page);
    await quickSwitcherInput(page).fill('a AND ) ***');

    // Give the debounced search a moment to fire and settle.
    await page.waitForTimeout(600);

    // No error toast (Toast.tsx renders `.folio-toast.error`, role="status") - this
    // is the surface QuickSwitcher uses to report a failed search - and no inline
    // error copy inside the palette itself. The error-text check is scoped to the
    // switcher dialog on purpose: a page-wide bare "500" substring match false-fires
    // on legitimate accumulated content (word counts, ids, timestamps, snippets) once
    // the DB has grown, which is not what "the search errored" means.
    await expect(page.locator('.folio-toast.error')).toHaveCount(0);
    const palette = page.getByTestId(TESTIDS.quickSwitcher);
    await expect(palette.getByText(/something went wrong|unexpected error|search failed/i)).toHaveCount(0);
    await expect(palette).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByTestId(TESTIDS.quickSwitcher)).not.toBeVisible();
  });
});
