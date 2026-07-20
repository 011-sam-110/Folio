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
import { generateRecoveryKey, hashRecoveryKey, verifyRecoveryKey } from '../auth/recovery.js';
import { seedNewUser } from '../seed.js';

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

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

  // Folio sends no email, so a forgotten password would otherwise be an
  // unrecoverable account. The key is shown exactly once in the signup response
  // and only its hash is kept, so nobody — including us — can reproduce it later.
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
  const { resolveSession } = await import('../auth/session.js');
  const id = await resolveSession(readCookie(req, COOKIE_NAME));
  if (!id) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }
  const row = await db
    .prepare('SELECT id, email, display_name FROM users WHERE id = ?')
    .get<UserRow>(id);
  if (!row) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }
  res.json({ user: publicUser(row) });
});

router.post('/password', requireAuth, async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const current = String(b.currentPassword ?? '');
  const next = String(b.newPassword ?? '');
  if (next.length < MIN_PASSWORD) {
    res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters` });
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

  // One message for every failure mode — wrong email, wrong key, already-used key —
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

  // Anyone holding a stolen session is evicted — recovery implies the account may
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
