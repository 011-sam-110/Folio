import { expect, test } from './auth.fixture';
import {
  TESTIDS,
  createNoteViaButton,
  createNotebookViaSidebar,
  editorBody,
  openNotebook,
  setNoteTitle,
  typeInEditor,
  uniqueName,
  waitForSaved,
} from './utils';

// NOTE: docs/SPEC.md's keyboard table binds "save named version" to Ctrl/Cmd+Alt+S.
// That key combo risks colliding with the real browser's native "Save Page As"
// dialog under Chromium automation (which can't be dismissed and would hang the
// test), so this spec drives the equivalent "Snapshot now" button from the
// History drawer (docs/FRONTEND.md) instead of the keyboard shortcut.

test.describe('Version history', () => {
  test('a manual snapshot appears in History, and restoring it reverts the editor content', async ({ page }) => {
    const notebookName = uniqueName('E2E Version Notebook');
    const noteTitle = uniqueName('Versioned Note');
    const originalText = 'Original content before any snapshot.';
    const laterText = 'Completely different content typed after the snapshot was taken.';
    const label = uniqueName('checkpoint');

    await page.goto('/');
    await createNotebookViaSidebar(page, notebookName);
    await openNotebook(page, notebookName);
    await createNoteViaButton(page);
    await setNoteTitle(page, noteTitle);
    await typeInEditor(page, originalText);
    await waitForSaved(page);

    await page.getByRole('button', { name: /history/i }).click();
    const drawer = page.getByTestId(TESTIDS.historyDrawer);
    await expect(drawer).toBeVisible({ timeout: 10_000 });

    // Support either an inline label field or a native prompt() for the label.
    let dialogHandled = false;
    page.once('dialog', async (d) => {
      dialogHandled = true;
      await d.accept(label);
    });
    await drawer.getByRole('button', { name: /snapshot now/i }).click();
    await page.waitForTimeout(400);
    if (!dialogHandled) {
      const labelInput = drawer.getByPlaceholder(/label/i).or(page.getByPlaceholder(/label/i));
      if (await labelInput.count()) {
        await labelInput.fill(label);
        const confirmBtn = drawer.getByRole('button', { name: /^(save|snapshot|confirm|create)\b/i }).first();
        if (await confirmBtn.count()) await confirmBtn.click();
      }
    }

    const labeledVersion = drawer.getByTestId(TESTIDS.historyVersionItem).filter({ hasText: label }).first();
    await expect(labeledVersion).toBeVisible({ timeout: 10_000 });

    // Change the note's content after the snapshot was taken.
    const body = editorBody(page);
    await body.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.type(laterText, { delay: 10 });
    await waitForSaved(page);
    await expect(body).toContainText(laterText);

    // Re-open history if the drawer closed as a side effect of editing, then restore
    // the labeled checkpoint.
    if (!(await drawer.isVisible())) {
      await page.getByRole('button', { name: /history/i }).click();
      await expect(drawer).toBeVisible({ timeout: 10_000 });
    }
    await drawer.getByTestId(TESTIDS.historyVersionItem).filter({ hasText: label }).first().click();
    await drawer.getByRole('button', { name: /restore/i }).click();

    // Exact toast copy — a page-wide /restor/i regex also matches any notebook/note whose
    // NAME contains "restor" (sidebar rows), which made this assertion collide with other
    // specs' leftover fixtures.
    await expect(page.getByText('Note restored')).toBeVisible({ timeout: 10_000 });
    await expect(body).toContainText(originalText);
    await expect(body).not.toContainText(laterText);
  });
});
