/**
 * Guest mode, end to end.
 *
 * Deliberately does NOT use e2e/auth.fixture.ts: every other spec exists to prove the app
 * works with a session, and this one exists to prove it works without one. `storageState`
 * is cleared so the browser arrives as a real first-time visitor.
 *
 * The load-bearing assertion is the network one. Guest mode's whole promise is that
 * nothing leaves the browser, and the only way to test a promise like that is to watch the
 * wire rather than to trust the code that was supposed to implement it.
 */
import { test, expect, type Page } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });

const PASSWORD = 'e2e-folio-password';

function uniqueEmail(): string {
  return `guest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

/** Every request the page makes to a note-mutating endpoint. Should stay empty. */
function watchWrites(page: Page): string[] {
  const writes: string[] = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (!url.pathname.startsWith('/api')) return;
    if (req.method() === 'GET') return;
    // Signing up and logging in are the two calls guest mode is allowed to make.
    if (url.pathname.startsWith('/api/auth/')) return;
    writes.push(`${req.method()} ${url.pathname}`);
  });
  return writes;
}

test('the landing page offers a way in without an account', async ({ page }) => {
  await page.goto('/');
  const tryLink = page.getByRole('link', { name: /try it without an account/i });
  await expect(tryLink).toBeVisible();
  await tryLink.click();
  await expect(page).toHaveURL(/\/note\//);
  await expect(page.getByTestId('guest-banner')).toContainText('Nothing here is saved');
});

test('a guest can write, and the work survives a reload without any server write', async ({ page }) => {
  const writes = watchWrites(page);

  await page.goto('/try');
  await expect(page).toHaveURL(/\/note\//);

  await page.getByLabel('Note title').fill('Lecture 1: sorting');
  await page.getByTestId('note-editor').click();
  await page.keyboard.type('Merge sort is n log n in the worst case.');

  // The autosave debounce is 800ms; give it room to have fired if it were going to.
  await page.waitForTimeout(1500);
  await page.reload();

  await expect(page.getByLabel('Note title')).toHaveValue('Lecture 1: sorting');
  await expect(page.getByTestId('note-editor')).toContainText('Merge sort is n log n');
  // The banner is on the note page too, not just the dashboard - that is the point of it.
  await expect(page.getByTestId('guest-banner')).toBeVisible();

  expect(writes, 'guest mode must not write to the server').toEqual([]);
});

test('the sidebar Export control offers the guest their own notes', async ({ page }) => {
  await page.goto('/try');
  await page.getByLabel('Note title').fill('Exportable');
  await page.waitForTimeout(1200);

  await page.getByTestId('export-button').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('1 note');
  await expect(dialog).toContainText('Download .zip');
});

test('signing up offers to bring the guest notes into the new account', async ({ page }) => {
  await page.goto('/try');
  await expect(page).toHaveURL(/\/note\//);
  await page.getByLabel('Note title').fill('Carried across');
  await page.getByTestId('note-editor').click();
  await page.keyboard.type('This should end up in the account.');
  await page.waitForTimeout(1200);

  await page.goto('/signup');
  await page.getByLabel('Email').fill(uniqueEmail());
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();

  // The recovery key is shown once and gated behind an acknowledgement. The handover
  // prompt must NOT be on screen yet: it would steal focus from the only render of a
  // credential that cannot be reissued.
  await expect(page.getByRole('dialog', { name: /Bring your notes with you/i })).toHaveCount(0);
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: /open unote/i }).click();

  const prompt = page.getByRole('dialog', { name: /Bring your notes with you/i });
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText('None of it has been saved');
  await prompt.getByRole('button', { name: /Copy them into my account/i }).click();
  await expect(prompt).toBeHidden();

  // The note is the account's now: this reads it back through the server's own search,
  // which knows nothing about localStorage.
  const res = await page.request.get('/api/search?q=Carried%20across&limit=10');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { results: Array<{ note: { title: string } }> };
  expect(body.results.map((r) => r.note.title)).toContain('Carried across');

  // And guest mode is over: the unsaved-work banner is gone.
  await expect(page.getByTestId('guest-banner')).toHaveCount(0);
});
