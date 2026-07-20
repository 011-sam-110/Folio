import { expect, test } from './auth.fixture';
import { apiCreateNote, apiCreateNotebook, editorBody, exact, sidebarNav, typeInEditor, uniqueName } from './utils';

test.describe('Mobile shell (Pixel 7)', () => {
  test('is usable at 390px: drawer opens via hamburger, a note opens, and the editor is typable', async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });

    const notebook = await apiCreateNotebook(request, uniqueName('E2E Mobile Shell Notebook'));
    const note = await apiCreateNote(request, notebook.id, uniqueName('Mobile Shell Note'));

    await page.goto('/');

    // Narrow enough to not collide with note cards whose titles contain "menu".
    const hamburger = page.getByRole('button', { name: /open menu|open sidebar|toggle sidebar/i });
    await expect(hamburger).toBeVisible({ timeout: 10_000 });
    await hamburger.click();

    const notebookLink = sidebarNav(page).getByRole('link', { name: exact(notebook.name) });
    await expect(notebookLink).toBeVisible({ timeout: 10_000 });
    await notebookLink.click();
    await page.waitForURL(/\/notebook\//, { timeout: 10_000 });

    await page.getByText(exact(note.title)).first().click();
    await page.waitForURL(/\/note\//, { timeout: 10_000 });

    await expect(page.getByPlaceholder('Untitled')).toHaveValue(note.title, { timeout: 10_000 });
    await typeInEditor(page, 'Typed on a 390px mobile viewport.');
    await expect(editorBody(page)).toContainText('Typed on a 390px mobile viewport.');
  });
});
