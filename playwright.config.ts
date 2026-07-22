import { defineConfig, devices } from '@playwright/test';

/**
 * E2E runs against its own API port, its own web port and its own Postgres
 * database, so a run can never collide with a dev server or touch real notes.
 *
 * The database is `folio_e2e`, NOT the `folio` dev database. Create it once with:
 *   docker exec folio-pg psql -U folio -d postgres -c "CREATE DATABASE folio_e2e OWNER folio;"
 * The server migrates it on boot, so no seed step is required - and there is no
 * longer one. Every spec now signs up its own account, and signup runs
 * `seedNewUser` (server/src/seed.ts), which is what provisions the starter
 * notebook and the built-in templates. The old `npm run seed -- --force` step
 * existed to plant the CLI demo vault that specs used to assert against; specs
 * that leaned on it (the study-queue filter) now seed their own flashcards, so
 * nothing shared remains for a reseed to race.
 */
const API_PORT = '4796';
const WEB_PORT = '5196';
const E2E_ENV = {
  FOLIO_PORT: API_PORT,
  FOLIO_WEB_PORT: WEB_PORT,
  DATABASE_URL: 'postgresql://folio:folio@localhost:5433/folio_e2e',
  // Turns off the auth rate limiter (server/src/auth/rateLimit.ts), which is exactly
  // what that module's docstring says to do for a test suite: every worker signs up,
  // and auth.spec.ts creates ~10 accounts, so a whole run makes far more than the
  // human-tuned 12-per-15-minutes from a single address. NODE_ENV is read nowhere
  // else in the server except a production guard in config.ts, so this changes
  // nothing else. The limiter's own behaviour is covered by server/src unit tests.
  NODE_ENV: 'test',
  // The repo .env points at :3001, but the local gateway container publishes on
  // :3002. Pinned here so the AI-backed specs reach a live gateway without the
  // e2e run depending on (or editing) a shared .env.
  FOLIO_AI_BASE_URL: 'http://localhost:3002/v1',
};

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },

  // Tests WITHIN a file stay serial: these specs build on each other's state
  // (create notebook → open it → add a note), and several use `mode: 'serial'`
  // explicitly. Files still run in parallel across workers, which is safe because
  // e2e/auth.fixture.ts gives every worker its own account - two files can never
  // see each other's notebooks even when they run at the same instant.
  fullyParallel: false,
  // Deliberately modest: three of the spec files drive the real AI gateway, and a
  // higher fan-out just gets those requests rate-limited upstream.
  workers: process.env.CI ? 2 : 3,
  retries: 1,
  reporter: [['list']],

  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'] },
      // The mobile specs were previously running in BOTH projects, because this one
      // declared no filter. That doubled them up and ran phone-shaped flows
      // (mobile-capture's chip row, the hamburger drawer) at desktop width, where
      // they are not the thing under test.
      testIgnore: /mobile.*\.spec\.ts/,
    },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /mobile.*\.spec\.ts/ },
  ],

  webServer: [
    {
      command: 'npm run start -w server',
      url: `http://localhost:${API_PORT}/api/health`,
      env: E2E_ENV,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'npm run dev -w web',
      url: `http://localhost:${WEB_PORT}`,
      env: E2E_ENV,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
