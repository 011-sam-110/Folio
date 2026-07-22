import crypto from 'node:crypto';
import { db } from '../db.js';
import { config } from '../config.js';

/**
 * Storage for a user's own AI provider key.
 *
 * Saving one takes the user off the shared free-tier pool: their calls authenticate with
 * their credential and skip the monthly quota entirely. That is the escape hatch for the
 * two cases the pool cannot serve - someone who needs more than the monthly allowance, and
 * someone behind a campus NAT whose shared IP ceiling is already spent.
 *
 * Encrypted, not hashed. A password only ever needs to be compared, so a one-way digest is
 * correct there; an API key has to be presented to the provider on every call, so it must
 * be recoverable. AES-256-GCM gives confidentiality plus an authentication tag, so a row
 * tampered with in the database fails to decrypt rather than silently yielding a different
 * key.
 */

const ALGORITHM = 'aes-256-gcm';

/**
 * Derive a 32-byte key from the configured KEK.
 *
 * SHA-256 of the secret rather than a KDF with a salt, deliberately: the input is a
 * high-entropy server-side secret, not a human-chosen password, so there is no weak
 * guessable space for a slow KDF to defend. Stretching it would cost latency on every
 * AI call and buy nothing.
 */
function derivedKey(): Buffer {
  return crypto.createHash('sha256').update(config.ai.kek).digest();
}

export interface StoredKey {
  apiKey: string;
  baseUrl: string | null;
  /** Model names to try in order at that endpoint. Empty means "use the operator's chain". */
  models: string[];
}

/** Stored as one comma-separated column; the app only ever wants the list. */
function splitModels(raw: string | null | undefined): string[] {
  return (raw ?? '').split(',').map(s => s.trim()).filter(Boolean);
}

function encrypt(plaintext: string): { ciphertext: string; iv: string; authTag: string } {
  // 96-bit IV, the size GCM is specified for. Random per write, never reused: reusing an
  // IV under the same key is the one mistake that breaks GCM catastrophically.
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, derivedKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

function decrypt(ciphertext: string, iv: string, authTag: string): string {
  const decipher = crypto.createDecipheriv(ALGORITHM, derivedKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** Last four characters, for a settings screen that shows which key is saved. */
export function hintFor(apiKey: string): string {
  return apiKey.length <= 4 ? '****' : apiKey.slice(-4);
}

export async function setUserKey(
  uid: string,
  apiKey: string,
  baseUrl?: string | null,
  models?: string[] | null,
): Promise<void> {
  const { ciphertext, iv, authTag } = encrypt(apiKey);
  const modelList = (models ?? []).map(m => m.trim()).filter(Boolean);
  await db
    .prepare(
      `INSERT INTO ai_keys (user_id, base_url, models, ciphertext, iv, auth_tag, hint)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE
         SET base_url = EXCLUDED.base_url,
             models = EXCLUDED.models,
             ciphertext = EXCLUDED.ciphertext,
             iv = EXCLUDED.iv,
             auth_tag = EXCLUDED.auth_tag,
             hint = EXCLUDED.hint`,
    )
    .run(uid, baseUrl ?? null, modelList.length ? modelList.join(',') : null, ciphertext, iv, authTag, hintFor(apiKey));
}

export async function deleteUserKey(uid: string): Promise<void> {
  await db.prepare('DELETE FROM ai_keys WHERE user_id = ?').run(uid);
}

/**
 * The user's decrypted key, or null if they have none saved.
 *
 * A decryption failure is reported as "no key" rather than thrown. The realistic cause is
 * a rotated KEK (see config.ai.kek), and the useful behaviour then is to fall back to the
 * shared pool so AI keeps working, rather than to 500 every AI request until the user
 * happens to visit settings and re-enter a key.
 */
export async function getUserKey(uid: string): Promise<StoredKey | null> {
  const row = await db
    .prepare('SELECT base_url, models, ciphertext, iv, auth_tag FROM ai_keys WHERE user_id = ?')
    .get<{ base_url: string | null; models: string | null; ciphertext: string; iv: string; auth_tag: string }>(uid);
  if (!row) return null;
  try {
    return {
      apiKey: decrypt(row.ciphertext, row.iv, row.auth_tag),
      baseUrl: row.base_url,
      models: splitModels(row.models),
    };
  } catch {
    console.error('[ai] stored key for user could not be decrypted; falling back to shared pool');
    return null;
  }
}

/** What the settings UI needs: whether a key exists and its last four characters. */
export async function getKeyHint(
  uid: string,
): Promise<{ present: boolean; hint: string; baseUrl: string | null; models: string[] }> {
  const row = await db
    .prepare('SELECT hint, base_url, models FROM ai_keys WHERE user_id = ?')
    .get<{ hint: string; base_url: string | null; models: string | null }>(uid);
  return {
    present: Boolean(row),
    hint: row?.hint ?? '',
    baseUrl: row?.base_url ?? null,
    models: splitModels(row?.models),
  };
}
