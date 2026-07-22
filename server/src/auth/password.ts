import {
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// OWASP's scrypt baseline (N=2^17, r=8, p=1). maxmem must be raised explicitly -
// Node's 32 MB default is below what N=2^17 needs and the call would throw.
const PARAMS = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const KEY_LEN = 64;
const SALT_LEN = 16;

export interface PasswordRecord {
  hash: string;
  salt: string;
}

/** Hash a password with a fresh random salt. */
export async function hashPassword(password: string): Promise<PasswordRecord> {
  const salt = randomBytes(SALT_LEN);
  const derived = await scrypt(password, salt, KEY_LEN, PARAMS);
  return { hash: derived.toString('hex'), salt: salt.toString('hex') };
}

/**
 * Verify a password against a stored hash+salt.
 *
 * Compared with timingSafeEqual so a response's timing cannot be used to recover
 * the hash byte by byte. Malformed stored values return false rather than
 * throwing, so a corrupt row denies access instead of 500ing the login route.
 */
export async function verifyPassword(
  password: string,
  record: PasswordRecord,
): Promise<boolean> {
  let expected: Buffer;
  try {
    expected = Buffer.from(record.hash, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== KEY_LEN) return false;

  const derived = await scrypt(password, Buffer.from(record.salt, 'hex'), KEY_LEN, PARAMS);
  return timingSafeEqual(derived, expected);
}

