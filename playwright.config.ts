import { defineConfig, devices } from '@playwright/test';

// E2E runs on dedicated ports with a dedicated, freshly-seeded database so it
// never collides with a running dev server or touches real notes.
const API_PORT = '4781';
const WEB_PORT = '5174';
const E2E_ENV = {
  FOLIO_PORT: API_PORT,
  FOLIO_WEB_PORT: WEB_PORT,
  FOLIO_DB_PATH: 'data/e2e.db',
};

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: [['list']],
  // NOTE: the e2e DB is wiped + reseeded by the API webServer command below
  // (`seed --force && start`), not by a separate globalSetup. Seeding in a
  // globalSetup that deletes the DB file races the webServer opening that same
  // file, which fails on Windows (EPERM/delete-pending). Bundling seed→start into
  // one sequential command removes the race and guarantees a fresh DB per run.
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /mobile.*\.spec\.ts/ },
  ],
  webServer: [
    {
      // Reseed a deterministic DB, then start — sequentially, so the server only
      // opens the file after the seed has finished writing it.
      command: 'npm run seed -w server -- --force && npm run start -w server',
      url: `http://localhost:${API_PORT}/api/health`,
      env: E2E_ENV,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'npm run dev -w web',
      url: `http://localhost:${WEB_PORT}`,
      env: E2E_ENV,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
