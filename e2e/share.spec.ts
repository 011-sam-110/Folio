/**
 * Share links and guest join (web/src/features/share/, server/src/routes/share.ts).
 *
 * The interesting property here is that a guest has NO Folio account. Their access
 * is a per-share cookie that POST /api/share/:token/join sets, which is why
 * /join/:token sits outside RequireAuth in main.tsx. Every guest-side test below
 * therefore runs in its own browser context with no session at all — using the
 * signed-in worker context would prove nothing, because the owner can already read
 * their own note.
 *
 * NOTE: web/src/features/share/** is owned by another agent and is NOT edited here;
 * these specs only drive it.
 */
import { expect, test } from './auth.fixture';
import { apiCreateNote, apiCreateNotebook, uniqueName } from './utils';

const MARKER = 'SHARED-CONTENT-MARKER';

/**
 * Context options for a guest browser.
 *
 * `browser.newContext()` INHERITS the test's context options, storageState included —
 * so without this the "guest" carried the worker account's session, JoinPage
 * recognised them as the note's owner (it deliberately does that for the owner's own
 * link), skipped the join gate entirely, and the specs proved nothing.
 */
const GUEST: import('@playwright/test').BrowserContextOptions = {
  storageState: { cookies: [], origins: [] },
};

/** Owner-side: mint a link on an open note, returning its URL. */
async function mintShareLink(
  page: import('@playwright/test').Page,
  opts: { permission?: 'edit' | 'view'; password?: string } = {},
): Promise<string> {
  await page.getByTestId('share-open').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 10_000 });

  if (opts.permission === 'view') {
    await dialog.getByText('Can view', { exact: true }).click();
  }
  if (opts.password) {
    await dialog.getByRole('checkbox', { name: /require a password/i }).check();
    await dialog.getByLabel('Share password').fill(opts.password);
  }

  await dialog.getByRole('button', { name: 'Create link' }).click();

  const url = dialog.getByLabel('Your share link');
  await expect(url).toBeVisible({ timeout: 15_000 });
  const text = (await url.textContent())?.trim() ?? '';
  expect(text).toMatch(/\/join\/[A-Za-z0-9_-]+/);
  return text;
}

/** Turns a minted absolute URL into a path this page can navigate to. */
function joinPath(shareUrl: string): string {
  return new URL(shareUrl).pathname;
}

/** Guest-side: walk the join gate and land in the shared view. */
async function joinAsGuest(
  page: import('@playwright/test').Page,
  path: string,
  opts: { name?: string; password?: string } = {},
) {
  await page.goto(path);
  await expect(page.getByRole('button', { name: /^Open (note|whiteboard)$/ })).toBeVisible({ timeout: 15_000 });
  if (opts.name) await page.getByRole('textbox', { name: 'Your name' }).fill(opts.name);
  if (opts.password) await page.getByLabel('Password').fill(opts.password);
  await page.getByRole('button', { name: /^Open (note|whiteboard)$/ }).click();
}

/** Opens a freshly created note owned by the worker account. */
async function openOwnedNote(page: import('@playwright/test').Page, request: import('@playwright/test').APIRequestContext) {
  const notebook = await apiCreateNotebook(request, uniqueName('E2E Share Notebook'));
  const note = await apiCreateNote(request, notebook.id, uniqueName('Shared Note'), {
    contentText: `${MARKER} — the body a guest should be able to read.`,
  });
  await page.goto(`/note/${note.id}`);
  await expect(page.getByPlaceholder('Untitled')).toHaveValue(note.title, { timeout: 15_000 });
  return note;
}

test.describe('Share links (owner side)', () => {
  test('mints a link and lists it under Active links', async ({ page, request }) => {
    await openOwnedNote(page, request);

    const shareUrl = await mintShareLink(page);

    // Back out of the "copy your link" step and the new link is in the list.
    await page.getByRole('dialog').getByRole('button', { name: /done|back/i }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('.sh-link')).toHaveCount(1, { timeout: 10_000 });
    await expect(dialog.locator('.sh-link__badge')).toContainText('Can edit');

    // The button reflects that the note is now reachable by someone else.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('share-open')).toContainText('Shared', { timeout: 10_000 });
    expect(shareUrl).toContain('/join/');
  });

  test('a revoked link stops opening', async ({ page, request, browser }) => {
    await openOwnedNote(page, request);
    const shareUrl = await mintShareLink(page);
    const path = joinPath(shareUrl);

    // It works before the revoke.
    const before = await browser.newContext(GUEST);
    try {
      const guest = await before.newPage();
      await joinAsGuest(guest, path, { name: 'Early Guest' });
      await expect(guest.getByTestId('shared-note-editor')).toContainText(MARKER, { timeout: 20_000 });
    } finally {
      await before.close();
    }

    await page.getByRole('dialog').getByRole('button', { name: /done|back/i }).first().click();
    await page.getByRole('dialog').getByRole('button', { name: 'Revoke' }).click();
    await expect(page.getByRole('dialog').locator('.sh-link')).toHaveCount(0, { timeout: 10_000 });

    // And not after.
    const after = await browser.newContext(GUEST);
    try {
      const guest = await after.newPage();
      await guest.goto(path);
      await expect(guest.getByText(/doesn’t open anything|expired or been revoked/i)).toBeVisible({
        timeout: 15_000,
      });
    } finally {
      await after.close();
    }
  });
});

test.describe('Guest join', () => {
  test('a signed-out guest joins with a display name and reads the note', async ({ page, request, browser }) => {
    const note = await openOwnedNote(page, request);
    const path = joinPath(await mintShareLink(page));

    const guestContext = await browser.newContext(GUEST);
    try {
      const guest = await guestContext.newPage();

      // /join is public: it must render for someone with no session at all, rather
      // than bouncing them to the login wall like every guarded route does.
      await guest.goto(path);
      expect(new URL(guest.url()).pathname).toBe(path);
      await expect(guest.getByRole('heading', { name: note.title })).toBeVisible({ timeout: 15_000 });

      await joinAsGuest(guest, path, { name: 'Visiting Student' });

      await expect(guest.getByTestId('shared-note-editor')).toContainText(MARKER, { timeout: 20_000 });
      // The guest is identified by the name they chose, not as an account.
      await expect(guest.getByLabel('People on this link')).toContainText('Visiting Student', {
        timeout: 15_000,
      });
      // And they are still not signed in to Folio itself.
      const me = await guestContext.request.get('/api/auth/me');
      expect(me.status()).toBe(401);
    } finally {
      await guestContext.close();
    }
  });

  test('a view-only link renders the note but refuses edits', async ({ page, request, browser }) => {
    await openOwnedNote(page, request);
    const path = joinPath(await mintShareLink(page, { permission: 'view' }));

    const guestContext = await browser.newContext(GUEST);
    try {
      const guest = await guestContext.newPage();
      await joinAsGuest(guest, path, { name: 'Read Only Guest' });

      const editor = guest.getByTestId('shared-note-editor');
      await expect(editor).toContainText(MARKER, { timeout: 20_000 });

      // TipTap marks a non-editable doc with contenteditable="false" — the guest can
      // read every word and change none of them.
      await expect(editor).toHaveAttribute('contenteditable', 'false');
      // The title is static text rather than an input on a view-only share.
      await expect(guest.getByRole('textbox', { name: 'Note title' })).toHaveCount(0);
    } finally {
      await guestContext.close();
    }
  });

  test('an edit link lets the guest change the note, and the owner sees it', async ({
    page,
    request,
    browser,
  }) => {
    const note = await openOwnedNote(page, request);
    const path = joinPath(await mintShareLink(page, { permission: 'edit' }));
    const guestEdit = `GUEST-EDIT-${Date.now()}`;

    const guestContext = await browser.newContext(GUEST);
    try {
      const guest = await guestContext.newPage();
      await joinAsGuest(guest, path, { name: 'Editing Guest' });

      const editor = guest.getByTestId('shared-note-editor');
      await expect(editor).toContainText(MARKER, { timeout: 20_000 });
      await expect(editor).toHaveAttribute('contenteditable', 'true');

      await editor.click();
      await guest.keyboard.press('End');
      await guest.keyboard.type(` ${guestEdit}`, { delay: 10 });

      // The shared editor has its own saved-state chip — wait on that, not a timer.
      await expect(guest.locator('.sh-chip--ok')).toHaveText('Saved', { timeout: 20_000 });
    } finally {
      await guestContext.close();
    }

    // The owner's copy of the note really changed — checked the way the owner would
    // actually see it, by reopening the note in their own editor.
    await page.reload();
    await expect(page.getByTestId('note-editor')).toContainText(guestEdit, { timeout: 20_000 });

    const res = await request.get(`/api/notes/${note.id}`);
    expect(res.ok()).toBeTruthy();
    const { note: fresh } = await res.json();
    expect(JSON.stringify(fresh.contentJson)).toContain(guestEdit);
  });

  /**
   * KNOWN APP BUG — marked expected-to-fail rather than deleted, so it is tracked and
   * so this file turns red the moment it is fixed (an unexpected pass is a failure),
   * prompting the annotation to be removed.
   *
   * PATCH /api/share/:token/note (server/src/routes/share.ts) writes `content_json`
   * but never `content_text`:
   *
   *     if (b.contentJson && typeof b.contentJson === 'object') {
   *       await db.prepare('UPDATE notes SET content_json = ?, updated_at = ? WHERE id = ?')
   *     }
   *
   * The owner's own PATCH /api/notes/:id derives content_text alongside it (see
   * `plainTextFallback` in server/src/routes/notes.ts). content_text is what full-text
   * search queries, what note-card snippets render, and what is fed to the AI
   * endpoints — so anything a guest writes is invisible to search and shows a stale
   * snippet, indefinitely.
   *
   * NOT fixed here: server/src/routes/share.ts is being actively edited by the agent
   * that owns the share feature. The fix is to derive content_text in that handler the
   * way notes.ts does (exporting `plainTextFallback` so both can share it).
   */
  test.fail(
    'a guest edit also updates the note’s searchable text',
    async ({ page, request, browser }) => {
      const note = await openOwnedNote(page, request);
      const path = joinPath(await mintShareLink(page, { permission: 'edit' }));
      const guestEdit = `GUESTSEARCHABLE${Date.now()}`;

      const guestContext = await browser.newContext(GUEST);
      try {
        const guest = await guestContext.newPage();
        await joinAsGuest(guest, path, { name: 'Searching Guest' });
        const editor = guest.getByTestId('shared-note-editor');
        await expect(editor).toContainText(MARKER, { timeout: 20_000 });
        await editor.click();
        await guest.keyboard.press('End');
        await guest.keyboard.type(` ${guestEdit}`, { delay: 10 });
        await expect(guest.locator('.sh-chip--ok')).toHaveText('Saved', { timeout: 20_000 });
      } finally {
        await guestContext.close();
      }

      const res = await request.get(`/api/notes/${note.id}`);
      const { note: fresh } = await res.json();
      expect(fresh.contentText).toContain(guestEdit);
    },
  );

  test('a password-protected link refuses the wrong password and admits the right one', async ({
    page,
    request,
    browser,
  }) => {
    await openOwnedNote(page, request);
    const password = 'share-password-123';
    const path = joinPath(await mintShareLink(page, { password }));

    const guestContext = await browser.newContext(GUEST);
    try {
      const guest = await guestContext.newPage();
      await guest.goto(path);
      await expect(guest.getByLabel('Password')).toBeVisible({ timeout: 15_000 });

      await guest.getByRole('textbox', { name: 'Your name' }).fill('Password Guest');
      await guest.getByLabel('Password').fill('not-the-password');
      await guest.getByRole('button', { name: /^Open note$/ }).click();
      await expect(guest.getByRole('alert')).toContainText(/password isn’t right/i, { timeout: 15_000 });
      await expect(guest.getByTestId('shared-note-editor')).toHaveCount(0);

      await guest.getByLabel('Password').fill(password);
      await guest.getByRole('button', { name: /^Open note$/ }).click();
      await expect(guest.getByTestId('shared-note-editor')).toContainText(MARKER, { timeout: 20_000 });
    } finally {
      await guestContext.close();
    }
  });

  test('a made-up token does not open anything', async ({ browser }) => {
    const guestContext = await browser.newContext(GUEST);
    try {
      const guest = await guestContext.newPage();
      await guest.goto('/join/definitely-not-a-real-share-token');
      await expect(guest.getByText(/doesn’t open anything/i)).toBeVisible({ timeout: 15_000 });
      await expect(guest.getByTestId('shared-note-editor')).toHaveCount(0);
    } finally {
      await guestContext.close();
    }
  });
});
