// Client-side mirrors of the server's rules in server/src/routes/auth.ts. These exist
// to give instant inline feedback, NOT to be the real gate — the server re-validates
// everything, and its message wins whenever the two ever disagree.

/** Same shape the server accepts. Deliberately permissive: rejecting exotic-but-valid
 *  addresses is a worse failure than letting the server have the final say. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const MIN_PASSWORD = 8;
/** Mirrors MAX_PASSWORD in the server's auth.ts, where it bounds how much input scrypt
 *  will hash per request. Enforced here purely so the message arrives before the submit. */
export const MAX_PASSWORD = 128;

export function emailError(value: string): string | null {
  const email = value.trim();
  if (!email) return 'Enter your email address';
  if (!EMAIL_RE.test(email)) return 'Enter a valid email address';
  return null;
}

/** Login only checks presence — an existing account may predate any rule change,
 *  so telling someone their correct password is "too short" would be a dead end. */
export function loginPasswordError(value: string): string | null {
  if (!value) return 'Enter your password';
  // The maximum is mirrored even here, where the minimum deliberately is not: the server
  // rejects an over-long password before it compares anything, so signalling it early
  // beats a submit that can only ever come back as an error.
  if (value.length > MAX_PASSWORD) return `Password must be at most ${MAX_PASSWORD} characters`;
  return null;
}

export function newPasswordError(value: string): string | null {
  if (!value) return 'Choose a password';
  if (value.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters`;
  if (value.length > MAX_PASSWORD) return `Password must be at most ${MAX_PASSWORD} characters`;
  return null;
}

export type StrengthLevel = 0 | 1 | 2 | 3;

export interface Strength {
  /** 0 = too short to accept, 1–3 = accepted and increasingly resistant to guessing. */
  level: StrengthLevel;
  label: string;
  hint: string;
}

/**
 * A coarse, honest strength read: length carries most of the weight because it is what
 * actually costs an attacker time. We never block on it — anything meeting the server's
 * 8-character minimum is allowed through; this only nudges.
 */
export function passwordStrength(value: string): Strength {
  if (value.length < MIN_PASSWORD) {
    return {
      level: 0,
      label: 'Too short',
      hint: `${MIN_PASSWORD - value.length} more character${MIN_PASSWORD - value.length === 1 ? '' : 's'} to go`,
    };
  }

  const variety =
    Number(/[a-z]/.test(value)) + Number(/[A-Z]/.test(value)) + Number(/\d/.test(value)) + Number(/[^\w\s]/.test(value));

  let score = 0;
  if (value.length >= 12) score += 1;
  if (value.length >= 16) score += 1;
  if (variety >= 3) score += 1;

  if (score >= 3) return { level: 3, label: 'Strong', hint: 'Nice, that will hold up.' };
  if (score >= 1) return { level: 2, label: 'Good', hint: 'A longer passphrase would be even better.' };
  return { level: 1, label: 'Weak', hint: 'Longer is stronger. Try a memorable phrase.' };
}
