import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Every suite runs against the same Postgres database and resets the schema in its
    // own beforeAll, so two files running at once would drop each other's tables
    // mid-test. Under SQLite each suite had a private .db file and could run in
    // parallel; the shared server makes that a false economy.
    fileParallelism: false,
    // scrypt at OWASP parameters plus real round-trips to Postgres make the auth and
    // import suites slower than the 5s default.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
