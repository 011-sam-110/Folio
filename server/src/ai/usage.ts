import crypto from 'node:crypto';
import { db } from '../db.js';
import { config, SESSION_SECRET } from '../config.js';

/**
 * Monthly accounting for shared-pool AI calls.
 *
 * The in-memory limiter in auth/rateLimit.ts bounds a burst on ONE serverless instance and
 * is upfront about not being a global limit. That is the right shape for "stop a flood",
 * and the wrong shape entirely for "100 calls a month": instances are short-lived and
 * numerous, so an in-memory counter resets constantly and the real ceiling becomes
 * `limit x instances`. A monthly budget has to be durable, so it lives in Postgres.
 */

export type QuotaScope = 'user' | 'ip';

export interface QuotaState {
  scope: QuotaScope;
  used: number;
  limit: number;
  remaining: number;
}

export interface QuotaVerdict {
  allowed: boolean;
  /** Which dimension ran out. Only set when `allowed` is false. */
  blockedBy?: QuotaScope;
  user: QuotaState;
  ip: QuotaState;
  /** ISO timestamp at which both counters roll over. */
  resetAt: string;
}

/** Calendar month in UTC, e.g. `2026-07`. The partition key for every counter. */
function currentPeriod(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/** Start of the next UTC month, which is when the current period's counters reset. */
function periodResetAt(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

/**
 * Store a keyed hash of the IP rather than the address itself.
 *
 * An IP is personal data, and this table exists only to answer "has this address used its
 * allowance?" - a question a one-way hash answers just as well. Keyed with SESSION_SECRET
 * so a database leak cannot be reversed by hashing the whole IPv4 space, which is only
 * ~4 billion guesses and trivially enumerable against an unkeyed digest.
 */
function ipKey(ip: string): string {
  return crypto.createHmac('sha256', SESSION_SECRET).update(ip).digest('base64url').slice(0, 32);
}

async function readCount(scope: QuotaScope, subject: string, period: string): Promise<number> {
  const row = await db
    .prepare('SELECT calls FROM ai_usage WHERE scope = ? AND subject = ? AND period = ?')
    .get<{ calls: number }>(scope, subject, period);
  return row?.calls ?? 0;
}

/**
 * Would a shared-pool call be allowed right now?
 *
 * Read-then-write rather than a single atomic increment, and deliberately so. The counter
 * is incremented only by `recordUsage` AFTER a completion succeeds, which means a user is
 * never charged for a call that failed on the gateway's side - the common case with free
 * tiers, where a whole model chain can be rate-limited at once.
 *
 * The cost of that choice is a race: concurrent requests can each read the same count and
 * all pass. The overshoot is bounded by how many requests one user has genuinely in flight
 * (single digits, since the UI disables its AI controls while a call is pending), against a
 * monthly budget in the hundreds. Trading an exact ceiling for never billing a user for a
 * failure is the right way round for a free tier.
 */
export async function checkQuota(uid: string, ipAddress: string): Promise<QuotaVerdict> {
  const period = currentPeriod();
  const ipHash = ipKey(ipAddress);

  const [userUsed, ipUsed] = await Promise.all([
    readCount('user', uid, period),
    readCount('ip', ipHash, period),
  ]);

  const user: QuotaState = {
    scope: 'user',
    used: userUsed,
    limit: config.ai.freeMonthlyPerUser,
    remaining: Math.max(0, config.ai.freeMonthlyPerUser - userUsed),
  };
  const ip: QuotaState = {
    scope: 'ip',
    used: ipUsed,
    limit: config.ai.freeMonthlyPerIp,
    remaining: Math.max(0, config.ai.freeMonthlyPerIp - ipUsed),
  };

  // A request must clear BOTH dimensions. Either alone is trivially defeated: an account
  // cap by registering again, an IP cap by switching to a hotspot.
  const blockedBy: QuotaScope | undefined =
    user.remaining <= 0 ? 'user' : ip.remaining <= 0 ? 'ip' : undefined;

  return { allowed: !blockedBy, blockedBy, user, ip, resetAt: periodResetAt() };
}

/**
 * Charge one shared-pool call against both dimensions. Call only after a completion has
 * actually come back, so failures are free.
 *
 * Upsert rather than read-modify-write: two concurrent calls that both read `5` would both
 * write `6`, losing a charge. `ON CONFLICT DO UPDATE` increments server-side, where the row
 * lock makes it exact.
 */
export async function recordUsage(uid: string, ip: string): Promise<void> {
  const period = currentPeriod();
  const ipHash = ipKey(ip);

  const bump = async (scope: QuotaScope, subject: string) => {
    await db
      .prepare(
        `INSERT INTO ai_usage (scope, subject, period, calls, updated_at)
         VALUES (?, ?, ?, 1, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
         ON CONFLICT (scope, subject, period) DO UPDATE
           SET calls = ai_usage.calls + 1,
               updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
      )
      .run(scope, subject, period);
  };

  // Accounting must never take down a completion the user already received. A failure here
  // means one uncharged call, which is strictly better than a 500 on work that succeeded.
  await Promise.all([bump('user', uid), bump('ip', ipHash)]).catch((err: unknown) => {
    console.error('[ai] usage accounting failed', err);
  });
}

/** Drop a user's counters. Test-only helper; there is no product surface for this. */
export async function _resetUsage(uid: string): Promise<void> {
  await db.prepare('DELETE FROM ai_usage WHERE scope = ? AND subject = ?').run('user', uid);
}
