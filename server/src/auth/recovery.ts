// One-time account recovery keys.
//
// Folio sends no email, so a forgotten password would otherwise mean an unrecoverable
// account. Signup issues a key, shows it exactly once in the response, and stores only
// its hash — so nobody, including the operator, can reproduce it afterwards.
//
// Hashing reuses auth/password.ts rather than rolling its own KDF: a recovery key is a
// credential with the same threat model as a password, and it must resist an offline
// attack on a leaked `users` table identically.

import { randomBytes } from 'node:crypto';
import { hashPassword, verifyPassword, type PasswordRecord } from './password.js';

// Crockford-style alphabet: no I, L, O or U, so a hand-copied key cannot be ruined by
// 1/I/l or 0/O confusion (and no U, which keeps accidental words out of the key).
const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RECOVERY_GROUPS = 4;
const RECOVERY_GROUP_LEN = 5;

/**
 * A fresh recovery key, formatted as `XXXXX-XXXXX-XXXXX-XXXXX`.
 *
 * 20 characters from a 32-symbol alphabet is 100 bits of entropy. The alphabet length
 * divides 256 exactly, so indexing by `byte % 32` is uniform — no modulo bias, and no
 * rejection loop needed.
 */
export function generateRecoveryKey(): string {
  const bytes = randomBytes(RECOVERY_GROUPS * RECOVERY_GROUP_LEN);
  const chars = [...bytes].map((b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]);
  const groups: string[] = [];
  for (let i = 0; i < RECOVERY_GROUPS; i++) {
    groups.push(chars.slice(i * RECOVERY_GROUP_LEN, (i + 1) * RECOVERY_GROUP_LEN).join(''));
  }
  return groups.join('-');
}

/**
 * Canonical form of a user-entered recovery key: upper-cased, with dashes and
 * whitespace stripped, and confusable characters folded onto the ones the alphabet
 * actually uses.
 *
 * Excluding I/L/O/U from the alphabet stops us *emitting* an ambiguous key, but it
 * does nothing for a user who reads `0` off the screen and types `O`. Since a
 * generated key can never legitimately contain those four letters, folding them is
 * unambiguous — and it turns the most common transcription error from a failed
 * recovery into a successful one.
 *
 * Exported so that redemption normalises with exactly the same function that hashing
 * used — if the two ever diverged, a correctly-typed key would fail to verify.
 */
export function normalizeRecoveryKey(key: string): string {
  return key
    .replace(/[\s-]/g, '')
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V');
}

/** Hash a recovery key for storage. Same scrypt parameters as a password. */
export async function hashRecoveryKey(key: string): Promise<PasswordRecord> {
  return hashPassword(normalizeRecoveryKey(key));
}

/** Verify a user-entered recovery key against its stored hash+salt. */
export async function verifyRecoveryKey(key: string, record: PasswordRecord): Promise<boolean> {
  return verifyPassword(normalizeRecoveryKey(key), record);
}
