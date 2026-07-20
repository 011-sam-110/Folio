/**
 * Canvas boards (web/src/features/canvas/).
 *
 * A canvas is a note with kind='canvas' whose children are rows in canvas_items
 * rather than content inside the note body — so "did it save" cannot be read off
 * the document editor's autosave chip. There is no visible saved-state indicator
 * on a board at all.
 *
 * Rather than sleeping past the 350ms write-behind debounce, every assertion here
 * waits on the actual request the board makes (POST for a placement, PATCH for a
 * text or geometry change) and then re-reads the board from the server. That is a
 * real condition, so it is both faster and immune to a slow machine.
 */
import { expect, test } from './auth.fixture';
import { apiCreateNotebook, exact, uniqueName } from './utils';

const board = (page: import('@playwright/test').Page) => page.locator('.cv-board');
const items = (page: import('@playwright/test').Page) => page.locator('.cv-item');

/** Resolves when the board finishes POSTing a newly placed item. */
function waitForItemCreate(page: import('@playwright/test').Page) {
  return page.waitForResponse(
    (r) => /\/api\/canvas\/[^/]+\/items$/.test(r.url()) && r.request().method() === 'POST' && r.ok(),
    { timeout: 15_000 },
  );
}

/** Resolves when the board flushes its debounced batch PATCH. */
function waitForItemPatch(page: import('@playwright/test').Page) {
  return page.waitForResponse(
    (r) => /\/api\/canvas\/[^/]+\/items$/.test(r.url()) && r.request().method() === 'PATCH' && r.ok(),
    { timeout: 15_000 },
  );
}

/** Selects a tool then clicks the board, returning once the item is persisted. */
async function placeItem(
  page: import('@playwright/test').Page,
  tool: string,
  at: { x: number; y: number },
) {
  await page.getByRole('toolbar', { name: 'Canvas tools' }).getByRole('button', { name: tool, exact: true }).click();
  const created = waitForItemCreate(page);
  await board(page).click({ position: at });
  await created;
}

/**
 * Creates a canvas in `notebookId` through the notebook page's own control.
 *
 * Scoped to <main>: the sidebar carries its own icon button with the same
 * "New canvas" accessible name, so an unscoped lookup is ambiguous.
 */
async function newCanvas(page: import('@playwright/test').Page, notebookId: string) {
  await page.goto(`/notebook/${notebookId}`);
  await page.getByRole('main').getByRole('button', { name: 'New canvas' }).click();
  await page.waitForURL(/\/note\//, { timeout: 15_000 });
  await expect(board(page)).toBeVisible({ timeout: 15_000 });
  return page.url().match(/\/note\/([^/?#]+)/)![1];
}

/**
 * Polls the canvas API until `predicate` holds.
 *
 * A board has no saved-state chip, and its writes are debounced and batched, so
 * the server's own view of the board is the only unambiguous "it saved" signal.
 * Polling it is a real condition — not a sleep — and it does not care whether the
 * app expressed the change as a POST, a PATCH or a batch of both.
 */
async function expectBoardState(
  request: import('@playwright/test').APIRequestContext,
  noteId: string,
  predicate: (items: Array<{ kind: string; data: Record<string, unknown> }>) => boolean,
  message: string,
) {
  await expect
    .poll(
      async () => {
        const res = await request.get(`/api/canvas/${noteId}`);
        if (!res.ok()) return false;
        const { items } = await res.json();
        return predicate(items);
      },
      { timeout: 20_000, message },
    )
    .toBe(true);
}

test.describe('Canvas boards', () => {
  test('creates a board that renders the canvas shell rather than the document editor', async ({ page, request }) => {
    const notebook = await apiCreateNotebook(request, uniqueName('E2E Canvas Notebook'));
    await newCanvas(page, notebook.id);

    // A canvas is a note, but it must NOT get the prose editor.
    await expect(page.getByRole('toolbar', { name: 'Canvas tools' })).toBeVisible();
    await expect(page.getByTestId('note-editor')).toHaveCount(0);
    await expect(page.getByLabel('Canvas title')).toHaveValue('Untitled canvas');
    // The board's own breadcrumb — the sidebar link to the same notebook shares its
    // accessible name, so this is matched by class rather than by role alone.
    await expect(page.locator('.cv-header__crumb')).toContainText(notebook.name);
  });

  test('a placed sticky keeps its text across a reload', async ({ page, request }) => {
    const notebook = await apiCreateNotebook(request, uniqueName('E2E Canvas Sticky Notebook'));
    const canvasId = await newCanvas(page, notebook.id);

    await placeItem(page, 'Sticky note', { x: 300, y: 240 });
    await expect(items(page)).toHaveCount(1);

    // Placing a sticky drops straight into editing it, so the textarea is already
    // focused — that behaviour is part of what is being checked here.
    const stickyText = `Deadlock notes ${Date.now()}`;
    const editor = board(page).locator('textarea');
    await expect(editor).toBeVisible({ timeout: 5_000 });
    await editor.fill(stickyText);

    // Escape commits the draft (CanvasItemView's textarea handles it explicitly),
    // which is a far more precise trigger than clicking at some empty coordinate.
    await editor.press('Escape');
    await expect(editor).toHaveCount(0);
    await expectBoardState(
      request,
      canvasId,
      (list) => list.some((i) => i.kind === 'sticky' && i.data.text === stickyText),
      'the sticky text never reached the server',
    );

    await page.reload();
    await expect(board(page)).toBeVisible({ timeout: 15_000 });
    await expect(items(page)).toHaveCount(1);
    await expect(page.locator('.cv-item--sticky')).toContainText(stickyText, { timeout: 10_000 });
  });

  test('places several kinds of item and persists all of them', async ({ page, request }) => {
    const notebook = await apiCreateNotebook(request, uniqueName('E2E Canvas Kinds Notebook'));
    await newCanvas(page, notebook.id);

    await placeItem(page, 'Rectangle', { x: 220, y: 200 });
    await placeItem(page, 'Ellipse', { x: 420, y: 200 });
    await placeItem(page, 'Sticky note', { x: 620, y: 320 });
    // Placing a sticky opens its editor; dismiss it so it does not swallow the
    // next interaction.
    await board(page).locator('textarea').press('Escape');

    await expect(items(page)).toHaveCount(3);

    await page.reload();
    await expect(board(page)).toBeVisible({ timeout: 15_000 });
    await expect(items(page)).toHaveCount(3, { timeout: 10_000 });
    await expect(page.locator('.cv-item--shape')).toHaveCount(2);
    await expect(page.locator('.cv-item--sticky')).toHaveCount(1);
  });

  test('undo removes a placed item, and the removal reaches the server', async ({ page, request }) => {
    const notebook = await apiCreateNotebook(request, uniqueName('E2E Canvas Undo Notebook'));
    const canvasId = await newCanvas(page, notebook.id);

    await placeItem(page, 'Rectangle', { x: 320, y: 260 });
    await expect(items(page)).toHaveCount(1);
    await expectBoardState(request, canvasId, (list) => list.length === 1, 'the rectangle was never saved');

    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(items(page)).toHaveCount(0);

    // The undo must reach the server, not just the local board.
    await expectBoardState(request, canvasId, (list) => list.length === 0, 'undo never reached the server');
    await page.reload();
    await expect(board(page)).toBeVisible({ timeout: 15_000 });
    await expect(items(page)).toHaveCount(0, { timeout: 10_000 });
  });

  test('zoom controls move the zoom readout and reset returns to 100%', async ({ page, request }) => {
    const notebook = await apiCreateNotebook(request, uniqueName('E2E Canvas Zoom Notebook'));
    await newCanvas(page, notebook.id);

    const readout = page.getByRole('button', { name: /Zoom \d+ percent/ });
    await expect(readout).toHaveText('100%');

    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await expect(readout).not.toHaveText('100%');
    const zoomedIn = Number(((await readout.textContent()) ?? '').replace('%', ''));
    expect(zoomedIn).toBeGreaterThan(100);

    await readout.click(); // reset
    await expect(readout).toHaveText('100%');

    await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
    const zoomedOut = Number(((await readout.textContent()) ?? '').replace('%', ''));
    expect(zoomedOut).toBeLessThan(100);
  });

  test('a canvas is listed in its notebook and reopens as a board', async ({ page, request }) => {
    const notebook = await apiCreateNotebook(request, uniqueName('E2E Canvas Listing Notebook'));
    await newCanvas(page, notebook.id);

    const title = uniqueName('Renamed Canvas');
    const titleField = page.getByLabel('Canvas title');
    await titleField.fill(title);
    // The title rides the note PATCH, not the canvas-items one.
    await page.waitForResponse(
      (r) => /\/api\/notes\/[^/]+$/.test(r.url()) && r.request().method() === 'PATCH' && r.ok(),
      { timeout: 15_000 },
    );

    await page.goto(`/notebook/${notebook.id}`);
    const card = page.getByRole('main').getByText(exact(title)).first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.click();

    await page.waitForURL(/\/note\//, { timeout: 10_000 });
    await expect(board(page)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByLabel('Canvas title')).toHaveValue(title);
  });
});
