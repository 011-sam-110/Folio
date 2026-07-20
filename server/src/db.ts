import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { DATABASE_URL, IS_SERVERLESS } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Postgres returns BIGINT (OID 20) as a string to avoid precision loss. Our only
// bigints are the identity PKs on note_versions/review_log, which stay far inside
// Number.MAX_SAFE_INTEGER and are compared numerically by callers.
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  // Each serverless instance holds its own pool, so keep per-instance connections
  // low to stay under Neon's ceiling when many instances are warm at once.
  max: IS_SERVERLESS ? 1 : 10,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
  ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? undefined : { rejectUnauthorized: false },
});

/**
 * Rewrite SQLite-style `?` placeholders to Postgres `$1..$n`.
 *
 * The whole route layer was written against better-sqlite3. Rather than hand-edit
 * ~95 SQL literals (and risk a silent off-by-one in a WHERE clause), the driver
 * adapts. Quoted runs and line comments are copied verbatim so a literal '?' in
 * text is never mistaken for a parameter.
 */
export function toPgPlaceholders(sql: string): string {
  let out = '';
  let n = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += ch;
      i++;
      while (i < sql.length) {
        out += sql[i];
        if (sql[i] === quote) {
          // A doubled quote is an escaped quote, not the end of the run.
          if (sql[i + 1] === quote) {
            out += sql[i + 1];
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') out += sql[i++];
      continue;
    }
    if (ch === '?') {
      out += '$' + ++n;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

type Params = readonly unknown[];

/**
 * Mirrors the slice of better-sqlite3's Statement API the route layer used, but
 * async. Keeping the `prepare(sql).all(...)` shape meant the migration added an
 * `await` at each call site instead of restructuring every handler.
 */
export interface Statement {
  all<T = Record<string, unknown>>(...params: Params): Promise<T[]>;
  get<T = Record<string, unknown>>(...params: Params): Promise<T | undefined>;
  run(...params: Params): Promise<{ changes: number }>;
}

interface Queryable {
  query(text: string, values?: unknown[]): Promise<pg.QueryResult>;
}

function statement(runner: Queryable, sql: string): Statement {
  const text = toPgPlaceholders(sql);
  return {
    async all<T>(...params: Params) {
      const r = await runner.query(text, params as unknown[]);
      return r.rows as T[];
    },
    async get<T>(...params: Params) {
      const r = await runner.query(text, params as unknown[]);
      return r.rows[0] as T | undefined;
    },
    async run(...params: Params) {
      const r = await runner.query(text, params as unknown[]);
      return { changes: r.rowCount ?? 0 };
    },
  };
}

export interface Db {
  prepare(sql: string): Statement;
  exec(sql: string): Promise<void>;
}

export const db: Db = {
  prepare: (sql) => statement(pool, sql),
  exec: async (sql) => {
    await pool.query(sql);
  },
};

/**
 * Run `fn` inside a transaction on one dedicated connection.
 *
 * The module-level `db` draws a possibly-different pooled connection per
 * statement, which would silently run the body outside the transaction — so the
 * callback receives its own scoped `Db` and must use that instead.
 */
export async function tx<T>(fn: (t: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const scoped: Db = {
    prepare: (sql) => statement(client, sql),
    exec: async (sql) => {
      await client.query(sql);
    },
  };
  try {
    await client.query('BEGIN');
    const result = await fn(scoped);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

let migrated: Promise<void> | null = null;

/**
 * Apply schema.sql. Idempotent, and de-duplicated so the concurrent requests that
 * hit a cold serverless instance run it once rather than racing each other.
 */
export function migrate(): Promise<void> {
  migrated ??= (async () => {
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(schema);
  })().catch((err) => {
    migrated = null; // let a later request retry rather than caching the failure
    throw err;
  });
  return migrated;
}

/** Purge notes soft-deleted more than `days` ago (and their cascaded history). */
export async function purgeExpiredDeletedNotes(days = 30): Promise<number> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const r = await db
    .prepare('DELETE FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < ?')
    .run(cutoff);
  return r.changes;
}

export function newId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  for (const b of bytes) id += alphabet[b % alphabet.length];
  return id;
}

export function nowIso(): string {
  return new Date().toISOString();
}
