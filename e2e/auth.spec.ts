/**
 * The account surfaces themselves: the login wall, signup (including the
 * one-and-only render of the recovery key), sign-in, sign-out, recovery-key
 * redemption, and the tenancy boundary between two accounts.
 *
 * Everything here runs SIGNED OUT. The rest of the suite gets a session handed to
 * it by e2e/auth.fixture.ts; these specs are about how that session is obtained in
 * the first place, so they clear it and drive the real forms.
 */
import { expect, test, uniqueEmail, TEST_PASSWORD } from './auth.fixture';
import { apiCreateNote, apiCreateNotebook, exact, sidebarNav, uniqueName } from './utils';

/**
 * No cookies: every test below starts as a stranger.
 *
 * IMPORTANT: create accounts with the standalone `request` fixture, never with
 * `page.context().request` — the latter SHARES the browser's cookie jar, so a
 * setup signup through it silently signs the browser in and the login wall these
 * specs exist to test never appears.
 */
test.use({ storageState: { cookies: [], origins: [] } });

/** Fills and submits the signup form, returning the recovery key it reveals. */
async function signUpThroughForm(
  page: import('@playwright/test').Page,
  email: string,
  password = TEST_PASSWORD,
  displayName?: string,
): Promise<string> {
  await page.goto('/signup');
  if (displayName) await page.getByLabel('Name').fill(displayName);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();

  const key = page.getByLabel('Your recovery key');
  await expect(key).toBeVisible({ timeout: 15_000 });
  const text = (await key.textContent())?.trim() ?? '';
  expect(text).toMatch(/^[A-Z0-9]{5}(-[A-Z0-9]{5}){3}$/);
  return text;
}

/** Clears the recovery-key gate (copy + acknowledge) and enters the app. */
async function leaveRecoveryPanel(page: import('@playwright/test').Page) {
  const continueBtn = page.getByRole('button', { name: /open folio/i });
  await expect(continueBtn).toBeDisabled();

  await page.getByRole('button', { name: 'Copy' }).click();
  await expect(continueBtn).toBeDisabled(); // copying alone is not enough
  await page.getByRole('checkbox').check();
  await expect(continueBtn).toBeEnabled();
  await continueBtn.click();
}

test.describe('The login wall', () => {
  test('a signed-out visitor is redirected to /login and returned to where they were headed', async ({ page, request }) => {
    await page.goto('/study');
    await page.waitForURL(/\/login/, { timeout: 10_000 });
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();

    // Sign in from here; the guard remembered the destination.
    const email = uniqueEmail('wall');
    const created = await request.post('/api/auth/signup', {
      data: { email, password: TEST_PASSWORD },
    });
    expect(created.status()).toBe(201);
    // The signup above authenticated the API context, not the browser, so the form
    // still has real work to do.
    await page.goto('/study');
    await page.waitForURL(/\/login/, { timeout: 10_000 });

    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill(TEST_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await page.waitForURL(/\/study/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Study' })).toBeVisible({ timeout: 10_000 });
  });

  test('the public routes render without a session', async ({ page }) => {
    for (const [path, heading] of [
      ['/login', 'Welcome back'],
      ['/signup', 'Create your account'],
      ['/recover', 'Use your recovery key'],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: heading })).toBeVisible({ timeout: 10_000 });
      expect(new URL(page.url()).pathname).toBe(path);
    }
  });
});

test.describe('Signup', () => {
  test('signup shows the recovery key once, gates past it, and lands in a seeded app', async ({ page }) => {
    const email = uniqueEmail('signup');
    await signUpThroughForm(page, email, TEST_PASSWORD, 'Signup Tester');
    await leaveRecoveryPanel(page);

    await page.waitForURL((url) => url.pathname === '/', { timeout: 15_000 });

    // seedNewUser gives a brand-new account exactly one starter notebook, so the app
    // is never a dead-end empty screen. That is the contract this asserts — not an
    // empty vault, and not the CLI demo vault either.
    await expect(sidebarNav(page).getByRole('link', { name: /My notes/ })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: new RegExp(`Account menu for Signup Tester`) })).toBeVisible();

    // The key is shown once and only once — it is not recoverable by revisiting.
    await page.goto('/signup');
    await page.waitForURL((url) => url.pathname === '/', { timeout: 10_000 });
    await expect(page.getByLabel('Your recovery key')).toHaveCount(0);
  });

  test('rejects a duplicate email and a too-short password without creating anything', async ({ page, request }) => {
    const email = uniqueEmail('dupe');

    // Establish the account through the API so this test is about the FORM's handling.
    const res = await request.post('/api/auth/signup', {
      data: { email, password: TEST_PASSWORD },
    });
    expect(res.status()).toBe(201);

    await page.goto('/signup');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill(TEST_PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText(/already exists/i)).toBeVisible({ timeout: 10_000 });
    expect(new URL(page.url()).pathname).toBe('/signup');

    // Client-side rule: 8 characters. A short password never reaches the server.
    await page.getByLabel('Email').fill(uniqueEmail('short'));
    await page.getByLabel('Password', { exact: true }).fill('short');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText(/at least 8 characters/i).first()).toBeVisible({ timeout: 10_000 });
    expect(new URL(page.url()).pathname).toBe('/signup');
  });
});

test.describe('Login and logout', () => {
  test('signs in, and signing out puts the wall back up', async ({ page, request }) => {
    const email = uniqueEmail('login');
    const res = await request.post('/api/auth/signup', {
      data: { email, password: TEST_PASSWORD, displayName: 'Round Tripper' },
    });
    expect(res.status()).toBe(201);

    await page.goto('/login');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill(TEST_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL((url) => url.pathname === '/', { timeout: 15_000 });

    const accountMenu = page.getByRole('button', { name: /Account menu for Round Tripper/ });
    await expect(accountMenu).toBeVisible({ timeout: 15_000 });
    await accountMenu.click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();

    await page.waitForURL(/\/login/, { timeout: 10_000 });
    // And the session is genuinely gone server-side, not just cleared in React state.
    await page.goto('/');
    await page.waitForURL(/\/login/, { timeout: 10_000 });
  });

  test('a wrong password is refused with one message that does not reveal whether the email exists', async ({
    page,
    request,
  }) => {
    const email = uniqueEmail('badpass');
    await request.post('/api/auth/signup', { data: { email, password: TEST_PASSWORD } });

    await page.goto('/login');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill('definitely-not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    const knownEmailError = page.getByRole('alert');
    await expect(knownEmailError).toBeVisible({ timeout: 10_000 });
    const knownText = (await knownEmailError.textContent())?.trim();
    expect(knownText).toMatch(/incorrect email or password/i);
    expect(new URL(page.url()).pathname).toBe('/login');

    // An address with no account must produce the SAME message — a different one
    // would turn this form into an account-enumeration oracle.
    await page.getByLabel('Email').fill(uniqueEmail('nobody'));
    await page.getByLabel('Password', { exact: true }).fill('definitely-not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toBeVisible({ timeout: 10_000 });
    expect((await page.getByRole('alert').textContent())?.trim()).toBe(knownText);
  });
});

test.describe('Recovery key redemption', () => {
  test('redeems a key at /recover, sets a new password, and issues a replacement', async ({ page }) => {
    const email = uniqueEmail('recover');
    const originalKey = await signUpThroughForm(page, email);
    await leaveRecoveryPanel(page);
    await page.waitForURL((url) => url.pathname === '/', { timeout: 15_000 });

    // Sign out, then come back through the "forgot password" route.
    await page.getByRole('button', { name: /Account menu for/ }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await page.waitForURL(/\/login/, { timeout: 10_000 });

    // The login form's Email field is autoFocused, so clicking this link blurs it and
    // triggers a validation re-render in the same tick — which can detach the anchor
    // between the hit-test and the click, losing the router navigation. Retry on the
    // URL rather than on a timer; navigating to /recover is idempotent.
    const forgot = page.getByRole('link', { name: /forgot your password/i });
    await expect(forgot).toHaveAttribute('href', '/recover');
    await expect(async () => {
      if (!/\/recover/.test(page.url())) await forgot.click();
      expect(new URL(page.url()).pathname).toBe('/recover');
    }).toPass({ timeout: 15_000 });

    const newPassword = 'a-brand-new-password';
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Recovery key').fill(originalKey);
    await page.getByLabel('New password').fill(newPassword);
    await page.getByRole('button', { name: 'Reset password' }).click();

    // Redemption consumes the old key and immediately issues a replacement, so the
    // account is never left without a way back in.
    const replacement = page.getByLabel('Your recovery key');
    await expect(replacement).toBeVisible({ timeout: 15_000 });
    const replacementKey = (await replacement.textContent())?.trim() ?? '';
    expect(replacementKey).toMatch(/^[A-Z0-9]{5}(-[A-Z0-9]{5}){3}$/);
    expect(replacementKey).not.toBe(originalKey);

    await leaveRecoveryPanel(page);
    await page.waitForURL((url) => url.pathname === '/', { timeout: 15_000 });

    // The new password is live...
    await page.getByRole('button', { name: /Account menu for/ }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await page.waitForURL(/\/login/, { timeout: 10_000 });
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill(newPassword);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL((url) => url.pathname === '/', { timeout: 15_000 });
  });

  test('a spent key cannot be redeemed twice, and a wrong key is refused', async ({ page }) => {
    const email = uniqueEmail('spent');
    const originalKey = await signUpThroughForm(page, email);
    await leaveRecoveryPanel(page);
    await page.waitForURL((url) => url.pathname === '/', { timeout: 15_000 });
    await page.getByRole('button', { name: /Account menu for/ }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await page.waitForURL(/\/login/, { timeout: 10_000 });

    // Spend it once.
    await page.goto('/recover');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Recovery key').fill(originalKey);
    await page.getByLabel('New password').fill('first-replacement-pass');
    await page.getByRole('button', { name: 'Reset password' }).click();
    await expect(page.getByLabel('Your recovery key')).toBeVisible({ timeout: 15_000 });
    await leaveRecoveryPanel(page);
    await page.waitForURL((url) => url.pathname === '/', { timeout: 15_000 });
    await page.getByRole('button', { name: /Account menu for/ }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await page.waitForURL(/\/login/, { timeout: 10_000 });

    // The same key a second time is a one-time credential already burned.
    await page.goto('/recover');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Recovery key').fill(originalKey);
    await page.getByLabel('New password').fill('second-replacement-pass');
    await page.getByRole('button', { name: 'Reset password' }).click();
    await expect(page.getByRole('alert')).toContainText(/not valid for this account/i, { timeout: 15_000 });
    expect(new URL(page.url()).pathname).toBe('/recover');

    // A garbage key is refused with the same message — no probing which part was wrong.
    await page.getByLabel('Recovery key').fill('AAAAA-BBBBB-CCCCC-DDDDD');
    await page.getByRole('button', { name: 'Reset password' }).click();
    await expect(page.getByRole('alert')).toContainText(/not valid for this account/i, { timeout: 15_000 });
  });
});

test.describe('Tenancy', () => {
  test("one account cannot see or open another account's notes", async ({ page, browser, request }) => {
    // Account A, with a note only it should know about.
    const ownerEmail = uniqueEmail('owner');
    const ownerCtx = await browser.newContext();
    try {
      const ownerApi = ownerCtx.request;
      const created = await ownerApi.post('/api/auth/signup', {
        data: { email: ownerEmail, password: TEST_PASSWORD },
      });
      expect(created.status()).toBe(201);

      const notebook = await apiCreateNotebook(ownerApi, uniqueName('E2E Private Notebook'));
      const secret = await apiCreateNote(ownerApi, notebook.id, uniqueName('Private Note'), {
        contentText: 'CONFIDENTIAL-TENANCY-MARKER that must never cross accounts.',
      });

      // Account B, in this test's own browser context.
      const intruderEmail = uniqueEmail('intruder');
      const signedUp = await request.post('/api/auth/signup', {
        data: { email: intruderEmail, password: TEST_PASSWORD },
      });
      expect(signedUp.status()).toBe(201);

      await page.goto('/login');
      await page.getByLabel('Email').fill(intruderEmail);
      await page.getByLabel('Password', { exact: true }).fill(TEST_PASSWORD);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.waitForURL((url) => url.pathname === '/', { timeout: 15_000 });

      // A's notebook is absent from B's sidebar...
      await expect(sidebarNav(page).getByRole('link', { name: exact(notebook.name) })).toHaveCount(0);

      // ...the API refuses B a direct read of A's note...
      const direct = await page.context().request.get(`/api/notes/${secret.id}`);
      expect(direct.ok()).toBeFalsy();

      // ...and navigating straight to the URL does not render its content.
      await page.goto(`/note/${secret.id}`);
      await expect(page.getByText('CONFIDENTIAL-TENANCY-MARKER')).toHaveCount(0);
    } finally {
      await ownerCtx.close();
    }
  });
});
