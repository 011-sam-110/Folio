import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB_PATH } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// FTS cascade-delete sync (notes_ad trigger) fires for notebook-cascade-deleted rows
// only when recursive triggers are on — its default has varied across SQLite builds,
// so pin it explicitly rather than depend on whatever better-sqlite3 bundles.
db.pragma('recursive_triggers = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// --- Idempotent migrations (schema.sql uses CREATE TABLE IF NOT EXISTS, so new
// columns on existing tables must be added here). Safe to run on every boot. ---
function ensureColumn(table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}
// Soft-delete: notes carry a deleted_at timestamp; all read paths exclude non-null.
ensureColumn('notes', 'deleted_at', 'deleted_at TEXT');

/** Purge notes soft-deleted more than `days` ago (and their cascaded history). Called on boot. */
export function purgeExpiredDeletedNotes(days = 30): number {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const info = db.prepare('DELETE FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < ?').run(cutoff);
  return info.changes;
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
