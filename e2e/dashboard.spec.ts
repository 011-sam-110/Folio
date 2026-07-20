import { expect, test } from './auth.fixture';
import { TESTIDS, apiCreateNote, apiCreateNotebook, noteCards, selectOptionMatching, uniqueName } from './utils';

test.describe('Dashboard', () => {
  test('shows seeded recents with relative times, non-zero stats, and a working continue card', async ({
    page,
    request,
  }) => {
    // Make sure there is at least one note to be "recent"/"continue" regardless of
    // what the seed database contains, so this spec doesn't depend on being run
    // before other specs mutate global state.
    const notebook = await apiCreateNotebook(request, uniqueName('E2E Dashboard Notebook'));
    const note = await apiCreateNote(request, notebook.id, uniqueName('Dashboard Smoke Note'), {
      contentText: 'Freshly created note that should show up as the most recent activity.',
    });

    await page.goto('/');

    const recentGrid = page.getByTestId(TESTIDS.recentGrid);
    await expect(recentGrid).toBeVisible({ timeout: 10_000 });
    await expect(recentGrid).toContainText(note.title);
    // Relative-time formatting somewhere in the recent grid (e.g. "just now", "2m ago").
    await expect(recentGrid.getByText(/ago|just now|today|yesterday/i).first()).toBeVisible();

    const continueCard = page.getByTestId(TESTIDS.continueCard);
    await expect(continueCard).toBeVisible();
    await expect(continueCard).toContainText(note.title);
    await continueCard.click();
    await page.waitForURL(new RegExp(`/note/${note.id}`), { timeout: 10_000 });

    await page.goto('/');
    const stats = page.getByTestId(TESTIDS.statsLine);
    await expect(stats).toBeVisible();
    const statsText = (await stats.textContent()) ?? '';
    expect(/[1-9]\d*/.test(statsText)).toBeTruthy();
  });

  test('notebook page lists notes and the sort toggle reorders them', async ({ page, request }) => {
    const notebook = await apiCreateNotebook(request, uniqueName('E2E Sort Notebook'));

    // Created in this order: "Zzz..." first (older), "Aaa..." second (newer).
    const older = await apiCreateNote(request, notebook.id, `Zzz Sort Last ${Date.now()}`);
    await new Promise((r) => setTimeout(r, 1100)); // ensure a distinct updated_at second
    const newer = await apiCreateNote(request, notebook.id, `Aaa Sort First ${Date.now()}`);

    await page.goto(`/notebook/${notebook.id}`);
    // title == snippet here (the note body defaults to its title), so the text
    // appears in both the card title and snippet — scope to the first match.
    await expect(page.getByText(newer.title).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(older.title).first()).toBeVisible();

    // Default sort is "updated" (most recent first) — the newer note should be
    // positioned before the older one in document order.
    const rowsUpdated = noteCards(page);
    const textsUpdated = await rowsUpdated.allTextContents();
    const idxNewerUpdated = textsUpdated.findIndex((t) => t.includes(newer.title));
    const idxOlderUpdated = textsUpdated.findIndex((t) => t.includes(older.title));
    expect(idxNewerUpdated).toBeGreaterThanOrEqual(0);
    expect(idxOlderUpdated).toBeGreaterThanOrEqual(0);
    expect(idxNewerUpdated).toBeLessThan(idxOlderUpdated);

    // Switch sort to title — alphabetically "Aaa..." sorts before "Zzz...".
    const sortSelect = page.getByRole('combobox', { name: /sort/i }).or(page.getByRole('combobox').first());
    await selectOptionMatching(sortSelect.first(), /title/i);

    await expect(async () => {
      const rows = noteCards(page);
      const texts = await rows.allTextContents();
      const idxA = texts.findIndex((t) => t.includes(newer.title)); // "Aaa..."
      const idxZ = texts.findIndex((t) => t.includes(older.title)); // "Zzz..."
      expect(idxA).toBeGreaterThanOrEqual(0);
      expect(idxZ).toBeGreaterThanOrEqual(0);
      expect(idxA).toBeLessThan(idxZ);
    }).toPass({ timeout: 10_000 });

    // NOTE: tag-chip filtering used to be asserted here off a note seeded with
    // `tags` through POST /api/notes. It now lives in tags.spec.ts, where the tag is
    // attached through the real chip editor instead of injected by the test.
  });
});
