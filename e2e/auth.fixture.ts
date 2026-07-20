/**
 * Authenticated test fixtures.
 *
 * Folio became multi-user partway through the build. Every route except /login,
 * /signup, /recover and /join/:token now redirects a session-less visitor to the
 * login wall, so a spec that just calls `page.goto('/')` tests the login page and
 * nothing else. This module is what puts a session behind every spec.
 *
 * Two decisions worth explaining, because they are the reason the suite can stay
 * both fast and parallel:
 *
 * 1. ACCOUNTS ARE CREATED THROUGH THE API, NOT THE SIGNUP FORM.
 *    Driving the form would make all nine specs depend on signup's markup, so a
 *    label change in SignupPage.tsx would fail the entire suite instead of the one
 *    spec that is actually about signup. It is also ~2s slower per account. The
 *    signup *UI* is covered exactly once, deliberately, in auth.spec.ts.
 *
 * 2. ONE ACCOUNT PER WORKER, PERSISTED AS storageState.
 *    Every spec shares one Postgres database, so isolation has to come from
 *    somewhere. Truncating tables between tests would force `workers: 1` and would
 *    test a state the app never actually reaches in production. Giving each worker
 *    its own account instead means specs cannot see each other's notebooks *because
 *    the app's own multi-tenant scoping keeps them apart* — the isolation mechanism
 *    and the thing under test are the same mechanism, so a tenancy leak shows up as
 *    a test failure rather than being papered over.
 *
 *    The session is captured once per worker into a storageState file. Playwright
 *    feeds that file to both the `page` context and the built-in `request` context,
 *    so existing specs get an authenticated browser AND authenticated API setup
 *    calls without changing a line of their bodies — only their import.
 *
 * Specs that need a guaranteed-pristine vault (no notebooks or notes beyond the
 * signup starter) can opt out of the shared worker account with `freshAccount()`.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  test as base,
  expect,
  request as playwrightRequest,
  type APIRequestContext,
} from '@playwright/test';

/** Where per-worker storageState files land. Gitignored via test-results/. */
const STATE_DIR = fileURLToPath(new URL('../test-results/.auth/', import.meta.url));

/** Long enough to satisfy the server's 8-character minimum with room to spare. */
export const TEST_PASSWORD = 'e2e-folio-password';

export interface Account {
  userId: string;
  email: string;
  password: string;
  displayName: string;
  /** Only ever returned by signup — this is the one moment it exists in the clear. */
  recoveryKey: string;
  /** Path to the Playwright storageState JSON holding this account's session cookie. */
  storageStatePath: string;
}

/**
 * Emails must be globally unique or signup answers 409, and this database is not
 * dropped between runs. A timestamp plus randomness makes collisions impossible
 * across reruns, retries and restarted workers alike.
 */
export function uniqueEmail(tag: string): string {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `e2e-${tag}-${stamp}-${rand}@folio.test`;
}

/**
 * Creates an account via POST /api/auth/signup and writes its session to a
 * storageState file.
 *
 * `baseURL` points at the web dev server, which proxies /api to the API — using
 * that origin (rather than the API port directly) is what makes the session cookie
 * land on the same host the browser will later load, so storageState actually
 * applies.
 */
export async function createAccount(
  baseURL: string,
  tag: string,
  statePath: string,
): Promise<Account> {
  const context = await playwrightRequest.newContext({ baseURL });
  try {
    const email = uniqueEmail(tag);
    const displayName = `E2E ${tag}`;
    const res = await context.post('/api/auth/signup', {
      data: { email, password: TEST_PASSWORD, displayName },
    });
    if (res.status() !== 201) {
      throw new Error(
        `signup for ${email} failed: ${res.status()} ${await res.text().catch(() => '')}`,
      );
    }
    const { user, recoveryKey } = await res.json();

    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await context.storageState({ path: statePath });

    return {
      userId: user.id,
      email,
      password: TEST_PASSWORD,
      displayName,
      recoveryKey,
      storageStatePath: statePath,
    };
  } finally {
    await context.dispose();
  }
}

interface WorkerFixtures {
  /** The account every test in this worker runs as. Created once, reused throughout. */
  workerAccount: Account;
}

interface TestFixtures {
  /** Same account as `workerAccount`, exposed test-scoped for convenience. */
  account: Account;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  workerAccount: [
    async ({}, use, workerInfo) => {
      // Worker fixtures cannot depend on the test-scoped `baseURL` option, so it is
      // read off the resolved project config instead.
      const baseURL = workerInfo.project.use.baseURL;
      if (!baseURL) throw new Error('playwright config must define use.baseURL');

      const statePath = path.join(STATE_DIR, `worker-${workerInfo.workerIndex}.json`);
      const account = await createAccount(baseURL, `w${workerInfo.workerIndex}`, statePath);
      await use(account);
    },
    { scope: 'worker' },
  ],

  // Overriding the built-in `storageState` OPTION is what silently authenticates
  // both `page` and `request` for every spec that imports this `test`.
  storageState: async ({ workerAccount }, use) => {
    await use(workerAccount.storageStatePath);
  },

  account: async ({ workerAccount }, use) => {
    await use(workerAccount);
  },
});

/**
 * A brand-new account plus an API context signed in as it, for the handful of specs
 * that must reason about a whole vault (dashboard counts, "is this list empty")
 * rather than about objects they created themselves.
 *
 * The caller owns disposal of the returned context; `use` it inside the test and
 * dispose in a finally, or prefer `test.use({ storageState })` if the whole file
 * wants the fresh identity.
 */
export async function freshAccount(
  baseURL: string,
  tag: string,
): Promise<{ account: Account; api: APIRequestContext }> {
  const statePath = path.join(STATE_DIR, `fresh-${tag}-${Date.now().toString(36)}.json`);
  const account = await createAccount(baseURL, tag, statePath);
  const api = await playwrightRequest.newContext({
    baseURL,
    storageState: account.storageStatePath,
  });
  return { account, api };
}

export { expect };
