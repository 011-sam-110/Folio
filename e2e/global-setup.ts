import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Runs once before the whole Playwright run (see playwright.config.ts `globalSetup`).
// Wipes any stale e2e database and re-seeds a deterministic one so every spec run
// starts from the same known fixture data, isolated from the real dev database.

const REPO_ROOT = path.resolve(__dirname, '..');
const DB_RELATIVE = 'data/e2e.db';
const DB_PATH = path.join(REPO_ROOT, DB_RELATIVE);

export default async function globalSetup(): Promise<void> {
  for (const suffix of ['', '-shm', '-wal', '-journal']) {
    const file = `${DB_PATH}${suffix}`;
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  }

  execSync('npm run seed -w server -- --force', {
    cwd: REPO_ROOT,
    env: { ...process.env, FOLIO_DB_PATH: DB_RELATIVE },
    stdio: 'inherit',
  });
}
