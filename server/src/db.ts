import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB_PATH } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

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
