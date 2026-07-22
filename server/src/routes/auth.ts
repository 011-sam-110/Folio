import { Router } from 'express';
import { db, newId, nowIso } from '../db.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import {
  COOKIE_NAME,
  clearSessionCookie,
  createSession,
  destroySession,
  pruneExpiredSessions,
  readCookie,
  setSessionCookie,
} from '../auth/session.js';
import { requireAuth, userId } from '../auth/middleware.js';
import { rateLimit } from '../auth/rateLimit.js';
import { generateRecoveryKey, hashRecoveryKey, verifyRecoveryKey, MAX_RECOVERY_KEY } from '../auth/recovery.js';
import { seedNewUser } from '../seed.js';

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;
/**
 * Upper bound on any password this server will hash.
 *
 * scrypt's initial PBKDF2 pass is linear in the length of its input, and `express.json`
 * accepts bodies up to 20mb (app.ts - a photo import posts its image inline, so it cannot
 * simply be lowered). Without a cap, a single unauthenticated request carrying a
 * multi-megabyte `password` makes the server burn CPU proportional to it, and the login
 * and recovery routes deliberately run a full hash even for unknown accounts to keep their
 * timing flat - so the cost is paid whether or not the address exists. 128 characters is
 * far above any real passphrase and turns that into a constant.
 *
 * Checked before the hash on EVERY route that accepts a password, including the ones that
 * only verify an existing one: an over-long value cannot match a stored hash anyway, so
 * rejecting it early costs a legitimate caller nothing.
 */
const MAX_PASSWORD = 128;
const TOO_LONG = `Password must be at most ${MAX_PASSWORD} characters`;

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  password_salt: string;
}

function publicUser(row: { id: string; email: string; display_name: string }) {
  return { id: row.id, email: row.email, displayName: row.display_name };
}

function validate(body: unknown): { email: string; password: string; error?: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const email = String(b.email ?? '').trim().toLowerCase();
  const password = String(b.password ?? '');
  if (!EMAIL_RE.test(email)) return { email, password, error: 'Enter a valid email address' };
  if (password.length < MIN_PASSWORD) {
    return { email, password, error: `Password must be at least ${MIN_PASSWORD} characters` };
  }
  if (password.length > MAX_PASSWORD) return { email, password, error: TOO_LONG };
  return { email, password };
}

router.post('/signup', rateLimit({ limit: 12, windowMs: 15 * 60_000 }), async (req, res) => {
  const { email, password, error } = validate(req.body);
  if (error) {
    res.status(400).json({ error });
    return;
  }

  const existing = await db
    .prepare('SELECT id FROM users WHERE lower(email) = ?')
    .get<{ id: string }>(email);
  if (existing) {
    res.status(409).json({ error: 'An account with that email already exists' });
    return;
  }

  const displayName = String((req.body as Record<string, unknown>)?.displayName ?? '')
    .trim()
    .slice(0, 80);
  const { hash, salt } = await hashPassword(password);

  // Unote sends no email, so a forgotten password would otherwise be an
  // unrecoverable account. The key is shown exactly once in the signup response
  // and only its hash is kept, so nobody - including us - can reproduce it later.
  const recoveryKey = generateRecoveryKey();
  const recovery = await hashRecoveryKey(recoveryKey);

  const id = newId();
  await db
    .prepare(
      `INSERT INTO users (id, email, display_name, password_hash, password_salt,
                          recovery_key_hash, recovery_key_salt, recovery_key_used, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .run(
      id,
      email,
      displayName || email.split('@')[0],
      hash,
      salt,
      recovery.hash,
      recovery.salt,
      nowIso(),
    );

  // A brand-new account with zero notebooks would land on a dead-end empty app,
  // so give it a starter notebook and the built-in templates.
  await seedNewUser(id);

  const token = await createSession(id);
  setSessionCookie(res, token);
  const row = await db
    .prepare('SELECT id, email, display_name FROM users WHERE id = ?')
    .get<UserRow>(id);
  res.status(201).json({ user: publicUser(row!), recoveryKey });
});

router.post('/login', rateLimit({ limit: 12, windowMs: 5 * 60_000, message: 'Too many sign-in attempts. Please wait a few minutes and try again.' }), async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const email = String(b.email ?? '').trim().toLowerCase();
  const password = String(b.password ?? '');

  // Length only - no minimum here, since an account may predate any change to that rule and
  // telling someone their correct password is "too short" would be a dead end. The maximum
  // is different: it is a cost bound, and it is applied before the hash below runs.
  if (password.length > MAX_PASSWORD) {
    res.status(400).json({ error: TOO_LONG });
    return;
  }

  const user = await db
    .prepare(
      'SELECT id, email, display_name, password_hash, password_salt FROM users WHERE lower(email) = ?',
    )
    .get<UserRow>(email);

  // Same message and a real hash comparison either way, so response content and
  // timing do not reveal whether an email is registered.
  const ok = user
    ? await verifyPassword(password, { hash: user.password_hash, salt: user.password_salt })
    : await verifyPassword(password, { hash: '00'.repeat(64), salt: '00'.repeat(16) });

  if (!user || !ok) {
    res.status(401).json({ error: 'Incorrect email or password' });
    return;
  }

  await pruneExpiredSessions();
  const token = await createSession(user.id);
  setSessionCookie(res, token);
  res.json({ user: publicUser(user) });
});

router.post('/logout', async (req, res) => {
  await destroySession(readCookie(req, COOKIE_NAME));
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', async (req, res) => {
  const { resolveSessionRecord } = await import('../auth/session.js');
  const session = await resolveSessionRecord(readCookie(req, COOKIE_NAME));
  if (!session) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }
  const row = await db
    .prepare('SELECT id, email, display_name FROM users WHERE id = ?')
    .get<UserRow>(session.userId);
  if (!row) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }
  // The scope is reported so the SPA can confine a QR-paired phone to /capture instead of
  // rendering a full app shell whose every fetch would come back 403. The server does not
  // rely on the client honouring it - see requireAuth.
  res.json({ user: publicUser(row), scope: session.scope });
});

/**
 * Exchange a QR pairing code for a capture-scoped session. UNAUTHENTICATED by necessity:
 * this is how a phone that has never signed in obtains a credential at all.
 *
 * The code is single-use and short-lived (auth/pairing.ts). What it grants is deliberately
 * not a sign-in: the session it opens carries scope 'capture', which auth/middleware.ts
 * admits only to listing notebooks and running one import. It cannot read notes, change
 * the password, or reach anything else.
 *
 * Rate-limited because the endpoint is a public oracle over a token space - not because
 * the token is guessable (256 random bits), but because an unlimited endpoint that does a
 * database write per call is a free amplifier.
 */
router.post(
  '/pair',
  rateLimit({
    limit: 20,
    windowMs: 5 * 60_000,
    message: 'Too many pairing attempts. Please wait a few minutes and try again.',
  }),
  async (req, res) => {
    const { redeemPairing, CAPTURE_SESSION_TTL_MS } = await import('../auth/pairing.js');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const token = typeof body.token === 'string' ? body.token : '';

    const uid = await redeemPairing(token);
    if (!uid) {
      // One message for unknown, expired and already-used. Distinguishing them would
      // confirm which codes ever existed, and the user-facing remedy is the same.
      res.status(401).json({
        error: 'This capture code has expired or has already been used. Generate a new one on your computer.',
      });
      return;
    }

    const row = await db
      .prepare('SELECT id, email, display_name FROM users WHERE id = ?')
      .get<UserRow>(uid);
    if (!row) {
      res.status(401).json({ error: 'This capture code is no longer valid.' });
      return;
    }

    const token2 = await createSession(uid, { scope: 'capture', ttlMs: CAPTURE_SESSION_TTL_MS });
    setSessionCookie(res, token2, CAPTURE_SESSION_TTL_MS);
    res.json({ user: publicUser(row), scope: 'capture' });
  },
);

router.post('/password', requireAuth, async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const current = String(b.currentPassword ?? '');
  const next = String(b.newPassword ?? '');
  if (next.length < MIN_PASSWORD) {
    res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters` });
    return;
  }
  // Both values reach scrypt on this route - `current` through verifyPassword and `next`
  // through hashPassword - so both are bounded.
  if (next.length > MAX_PASSWORD || current.length > MAX_PASSWORD) {
    res.status(400).json({ error: TOO_LONG });
    return;
  }
  const id = userId(req);
  const user = await db
    .prepare('SELECT id, email, display_name, password_hash, password_salt FROM users WHERE id = ?')
    .get<UserRow>(id);
  if (!user || !(await verifyPassword(current, { hash: user.password_hash, salt: user.password_salt }))) {
    res.status(403).json({ error: 'Current password is incorrect' });
    return;
  }
  const { hash, salt } = await hashPassword(next);
  await db
    .prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?')
    .run(hash, salt, id);
  // Changing a password should end sessions elsewhere; keep the current one alive.
  const keep = readCookie(req, COOKIE_NAME);
  await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  if (keep) {
    const token = await createSession(id);
    setSessionCookie(res, token);
  }
  res.json({ ok: true });
});

/**
 * Redeem a one-time recovery key to set a new password.
 *
 * Deliberately requires the email as well as the key: the key alone would be a
 * bearer credential that identifies the account, so a leaked key would let an
 * attacker discover which account it belongs to by brute-forcing nothing at all.
 */
router.post('/recover', rateLimit({ limit: 8, windowMs: 15 * 60_000, message: 'Too many recovery attempts. Please wait a few minutes and try again.' }), async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const email = String(b.email ?? '').trim().toLowerCase();
  const key = String(b.recoveryKey ?? '');
  const newPassword = String(b.newPassword ?? '');

  if (newPassword.length < MIN_PASSWORD) {
    res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters` });
    return;
  }
  // Unauthenticated, and it always spends scrypt time even for an unknown account, so the
  // bound has to be here - before the deliberate constant-time work below.
  if (newPassword.length > MAX_PASSWORD) {
    res.status(400).json({ error: TOO_LONG });
    return;
  }
  // `recoveryKey` reaches scrypt too, on both paths below: the real verify, and the dummy
  // verify that keeps an unknown account indistinguishable by latency. It needs its own
  // bound, not MAX_PASSWORD, because a recovery key is not a passphrase whose length we
  // have to guess at: this server generates every key it will ever accept, so the cap can
  // come from the generator itself. See MAX_RECOVERY_KEY in auth/recovery.ts.
  //
  // Checked before the lookup, so it is a flat rejection that reveals nothing about the
  // account. An over-long value could never normalise to a valid key anyway.
  if (key.length > MAX_RECOVERY_KEY) {
    res.status(400).json({ error: `Recovery key must be at most ${MAX_RECOVERY_KEY} characters` });
    return;
  }

  const user = await db
    .prepare(
      `SELECT id, email, display_name, recovery_key_hash, recovery_key_salt, recovery_key_used
         FROM users WHERE lower(email) = ?`,
    )
    .get<{
      id: string;
      email: string;
      display_name: string;
      recovery_key_hash: string | null;
      recovery_key_salt: string | null;
      recovery_key_used: number;
    }>(email);

  // One message for every failure mode - wrong email, wrong key, already-used key -
  // so this endpoint cannot be used to enumerate accounts or probe key validity.
  const reject = () => res.status(401).json({ error: 'That recovery key is not valid for this account' });

  if (!user || !user.recovery_key_hash || !user.recovery_key_salt || user.recovery_key_used === 1) {
    // Still spend the scrypt time so a missing account is not distinguishable by latency.
    await verifyRecoveryKey(key, { hash: '00'.repeat(64), salt: '00'.repeat(16) });
    reject();
    return;
  }

  const ok = await verifyRecoveryKey(key, {
    hash: user.recovery_key_hash,
    salt: user.recovery_key_salt,
  });
  if (!ok) {
    reject();
    return;
  }

  const { hash, salt } = await hashPassword(newPassword);
  // Issue the replacement key in the same statement that consumes the old one, so
  // the account is never left without a recovery route.
  const nextKey = generateRecoveryKey();
  const nextRecovery = await hashRecoveryKey(nextKey);

  await db
    .prepare(
      `UPDATE users
          SET password_hash = ?, password_salt = ?,
              recovery_key_hash = ?, recovery_key_salt = ?, recovery_key_used = 0
        WHERE id = ?`,
    )
    .run(hash, salt, nextRecovery.hash, nextRecovery.salt, user.id);

  // Anyone holding a stolen session is evicted - recovery implies the account may
  // already be compromised.
  await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);

  const token = await createSession(user.id);
  setSessionCookie(res, token);
  res.json({ user: publicUser(user), recoveryKey: nextKey });
});

/** Issue a fresh recovery key, invalidating the previous one. */
router.post('/recovery/regenerate', requireAuth, async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const password = String(b.password ?? '');
  const id = userId(req);

  // Re-auth below hashes this value, so it is bounded like every other password input.
  if (password.length > MAX_PASSWORD) {
    res.status(400).json({ error: TOO_LONG });
    return;
  }

  const user = await db
    .prepare('SELECT id, email, display_name, password_hash, password_salt FROM users WHERE id = ?')
    .get<UserRow>(id);
  // Re-authenticate: otherwise a briefly unattended session could be used to mint
  // a permanent way back into the account.
  if (!user || !(await verifyPassword(password, { hash: user.password_hash, salt: user.password_salt }))) {
    res.status(403).json({ error: 'Password is incorrect' });
    return;
  }

  const key = generateRecoveryKey();
  const rec = await hashRecoveryKey(key);
  await db
    .prepare(
      'UPDATE users SET recovery_key_hash = ?, recovery_key_salt = ?, recovery_key_used = 0 WHERE id = ?',
    )
    .run(rec.hash, rec.salt, id);

  res.json({ recoveryKey: key });
});

export default router;
