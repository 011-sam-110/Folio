// AI metering and bring-your-own-key.
//
// This is the code that decides who gets to spend the operator's money. Two ceilings guard
// one shared pool of free-tier provider keys (per account and per IP), and a user who saves
// their own provider key steps outside both. Everything here protects one of three
// properties: the ceilings actually stop people, a failed call is never charged, and a saved
// key is stored so that a database leak or a tampered row does not yield a usable secret.

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';

// vi.hoisted runs before the imports below are evaluated, which is the only window in which
// these matter: config.ts reads each one once at module load and freezes it into a plain
// number, so there is no later seam to reach through. Small limits keep the "exhaust the
// allowance" loops below to a handful of rows instead of the production 100/1000.
const LIMITS = vi.hoisted(() => {
  process.env.FOLIO_AI_FREE_MONTHLY_USER = '3';
  process.env.FOLIO_AI_FREE_MONTHLY_IP = '5';
  // chat() sleeps this long and re-runs the whole model chain when every model failed with
  // a rate-limit-class error. Zero keeps the failure tests instant.
  process.env.FOLIO_AI_RATELIMIT_RETRY_MS = '0';
  // Pin the key-encryption key so the crypto assertions do not depend on whatever
  // SESSION_SECRET the developer's .env happens to carry.
  process.env.FOLIO_AI_KEK = 'test-only-key-encryption-key';
  return { user: 3, ip: 5 };
});

import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { db, pool } from '../src/db.js';
import { checkQuota, recordUsage } from '../src/ai/usage.js';
import { setUserKey, getUserKey, getKeyHint, deleteUserKey, hintFor } from '../src/ai/keys.js';
import { resetDatabase, resetData, makeUser, closeDatabase, type TestUser } from './helpers.js';

const app = buildApp();

/**
 * Every request carries an explicit forwarded address, so `clientIp` resolves to a value the
 * test also handed to `recordUsage`. `trust proxy` is 1 in app.ts, so the rightmost
 * X-Forwarded-For entry wins; without the header the address would be the loopback socket
 * and the IP-dimension assertions would be counting a different subject.
 */
const IP = '203.0.113.10';

const KEY = 'sk-test-abcdef0123456789';

let alice: TestUser;

beforeAll(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetData();
  // resetData() is TRUNCATE users CASCADE. ai_keys cascades from users, but ai_usage
  // deliberately has no foreign key: its scope='ip' rows key on a hashed address rather
  // than a user id, so nothing cascades to it and the counters would otherwise leak into
  // the next test. That produces the worst kind of failure, one that only appears in suite
  // order, so clear the table explicitly.
  await pool.query('DELETE FROM ai_usage');
  alice = await makeUser(app);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await closeDatabase();
});

function get(user: TestUser, path: string) {
  return user.agent.get(path).set('X-Forwarded-For', IP);
}
function post(user: TestUser, path: string) {
  return user.agent.post(path).set('X-Forwarded-For', IP);
}
function put(user: TestUser, path: string) {
  return user.agent.put(path).set('X-Forwarded-For', IP);
}
function del(user: TestUser, path: string) {
  return user.agent.delete(path).set('X-Forwarded-For', IP);
}

/** Calls charged to one account this period. */
async function userCalls(uid: string): Promise<number> {
  const row = await db
    .prepare("SELECT calls FROM ai_usage WHERE scope = 'user' AND subject = ?")
    .get<{ calls: number }>(uid);
  return Number(row?.calls ?? 0);
}

/**
 * Calls charged to the IP dimension this period, summed across subjects. The subject is an
 * HMAC the test cannot recompute (ipKey is private, and rightly so), and every test here
 * drives a single address, so the sum is that address's counter.
 */
async function ipCalls(): Promise<number> {
  const row = await db
    .prepare("SELECT COALESCE(SUM(calls), 0) AS c FROM ai_usage WHERE scope = 'ip'")
    .get<{ c: number }>();
  return Number(row?.c ?? 0);
}

/** Spend `n` of the account's allowance, and `n` of the IP's alongside it. */
async function burn(uid: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await recordUsage(uid, IP);
}

/** A gateway that answers every model with the same completion. */
function stubGatewaySuccess(content = 'rewritten text') {
  const f = vi.fn(
    async () =>
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', f);
  return f;
}

/**
 * A gateway that fails every model. The message deliberately does not look rate-limited, so
 * chat() gives up after one pass through the chain rather than sleeping and retrying.
 */
function stubGatewayFailure() {
  const f = vi.fn(async () => new Response('upstream exploded', { status: 500 }));
  vi.stubGlobal('fetch', f);
  return f;
}

describe('monthly quota accounting', () => {
  // If config ever stops reading these variables the constants above become the production
  // defaults, every "exhaust the allowance" loop stops short of the ceiling, and the tests
  // that assert a block would pass for the wrong reason. Fail here instead.
  it('takes its limits from the environment', () => {
    expect(config.ai.freeMonthlyPerUser).toBe(LIMITS.user);
    expect(config.ai.freeMonthlyPerIp).toBe(LIMITS.ip);
  });

  it('allows a user who is under the monthly limit', async () => {
    await burn(alice.id, 1);
    const verdict = await checkQuota(alice.id, IP);
    expect(verdict.allowed).toBe(true);
    expect(verdict.blockedBy).toBeUndefined();
    expect(verdict.user).toMatchObject({ used: 1, limit: LIMITS.user, remaining: LIMITS.user - 1 });
  });

  // The limit is inclusive: a user whose count has reached it is done, not entitled to one
  // more. An exclusive comparison here would hand every account limit+1 calls, which is the
  // kind of off-by-one nobody notices until the pool is empty.
  it('blocks a user who is exactly at the limit', async () => {
    await burn(alice.id, LIMITS.user);
    const verdict = await checkQuota(alice.id, IP);
    expect(verdict.allowed).toBe(false);
    expect(verdict.blockedBy).toBe('user');
    expect(verdict.user).toMatchObject({ used: LIMITS.user, remaining: 0 });
  });

  // The anti-multi-account property, and the reason a second dimension exists at all. An
  // account cap alone falls to signing up again, so an address that has spent the network
  // allowance has to refuse a brand-new account that has never made a call.
  it('refuses a user with an untouched account allowance once the IP allowance is spent', async () => {
    for (let i = 0; i < LIMITS.ip; i++) {
      const sharer = await makeUser(app);
      await recordUsage(sharer.id, IP);
    }

    const verdict = await checkQuota(alice.id, IP);
    expect(verdict.user.used).toBe(0);
    expect(verdict.user.remaining).toBe(LIMITS.user);
    expect(verdict.ip).toMatchObject({ used: LIMITS.ip, remaining: 0 });
    expect(verdict.allowed).toBe(false);
    expect(verdict.blockedBy).toBe('ip');
  });

  it('charges both dimensions for a single call', async () => {
    await recordUsage(alice.id, IP);
    const verdict = await checkQuota(alice.id, IP);
    expect(verdict.user.used).toBe(1);
    expect(verdict.ip.used).toBe(1);
  });

  // Counters are partitioned by UTC calendar month, so last month's spend must not follow a
  // user into this one. The stale period is derived from the current date via Date.UTC with
  // a month of -1, which rolls into the previous December correctly, so this does not depend
  // on which month or day the suite happens to run on.
  it('ignores a row from a previous period', async () => {
    const now = new Date();
    const stalePeriod = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
      .toISOString()
      .slice(0, 7);
    const staleCalls = LIMITS.user + 10;

    await db
      .prepare('INSERT INTO ai_usage (scope, subject, period, calls) VALUES (?, ?, ?, ?)')
      .run('user', alice.id, stalePeriod, staleCalls);

    const verdict = await checkQuota(alice.id, IP);
    expect(verdict.allowed).toBe(true);
    expect(verdict.user.used).toBe(0);

    // Guards against the test going vacuous: if the insert silently landed in the current
    // period, or did not land at all, the assertions above would still pass.
    const stale = await db
      .prepare("SELECT calls FROM ai_usage WHERE scope = 'user' AND subject = ? AND period = ?")
      .get<{ calls: number }>(alice.id, stalePeriod);
    expect(Number(stale?.calls)).toBe(staleCalls);
    expect(stalePeriod).not.toBe(new Date().toISOString().slice(0, 7));
  });

  // recordUsage upserts with `calls = ai_usage.calls + 1` rather than reading and writing
  // back, specifically so simultaneous calls cannot both read the same number and both
  // write the same successor. A lost increment is a free call, and the ceiling is only as
  // real as the counting underneath it.
  it('loses no increment when calls are recorded concurrently', async () => {
    await Promise.all(Array.from({ length: 8 }, () => recordUsage(alice.id, IP)));

    expect(await userCalls(alice.id)).toBe(8);
    expect(await ipCalls()).toBe(8);
  });

  // The two dimensions have to partition independently, or the second one is decoration:
  // if the IP subject collapsed (a constant hash, say) every user in the world would share
  // one network counter, and if the account subject leaked across users one person's spend
  // would lock out everyone else.
  it('keeps separate accounts on one address apart while sharing that address', async () => {
    const bob = await makeUser(app);
    await burn(alice.id, 2);
    await recordUsage(bob.id, IP);

    expect(await userCalls(alice.id)).toBe(2);
    expect(await userCalls(bob.id)).toBe(1);

    const forAlice = await checkQuota(alice.id, IP);
    const forBob = await checkQuota(bob.id, IP);
    expect(forAlice.user.used).toBe(2);
    expect(forBob.user.used).toBe(1);
    // Both see the same shared network total.
    expect(forAlice.ip.used).toBe(3);
    expect(forBob.ip.used).toBe(3);
  });

  it('counts two different addresses separately', async () => {
    await recordUsage(alice.id, '198.51.100.1');
    await recordUsage(alice.id, '198.51.100.2');

    expect((await checkQuota(alice.id, '198.51.100.1')).ip.used).toBe(1);
    expect((await checkQuota(alice.id, '198.51.100.2')).ip.used).toBe(1);
    expect((await checkQuota(alice.id, '198.51.100.3')).ip.used).toBe(0);
    // Same account both times, so its own counter saw both calls.
    expect(await userCalls(alice.id)).toBe(2);
  });

  // The 429 tells the client when to stop showing the error. Asserted structurally rather
  // than against a fixed date so it holds on the 1st and the 31st alike.
  it('reports a resetAt at the start of the next UTC month', async () => {
    const { resetAt } = await checkQuota(alice.id, IP);
    const reset = new Date(resetAt);
    expect(reset.getUTCDate()).toBe(1);
    expect(reset.getUTCHours()).toBe(0);
    expect(reset.getUTCMinutes()).toBe(0);
    expect(reset.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('metering a completion', () => {
  it('charges one call to each dimension when the completion succeeds', async () => {
    stubGatewaySuccess('# Better\n\ntext');
    const res = await post(alice, '/api/ai/improve').send({ text: 'some rough notes' });

    expect(res.status).toBe(200);
    expect(await userCalls(alice.id)).toBe(1);
    expect(await ipCalls()).toBe(1);
  });

  // recordUsage runs only after chat() returns, so a gateway that is refusing the whole
  // model chain (the ordinary case on a free tier) costs the user nothing. Charging for a
  // failure would let a bad afternoon upstream silently eat someone's month.
  it('leaves both counters untouched when the completion fails', async () => {
    const gateway = stubGatewayFailure();
    const res = await post(alice, '/api/ai/improve').send({ text: 'some rough notes' });

    expect(res.status).toBe(502);
    expect(gateway).toHaveBeenCalled();
    expect(await userCalls(alice.id)).toBe(0);
    expect(await ipCalls()).toBe(0);
  });

  // A blocked request must not reach the gateway at all. If it did, the pool would still be
  // spent and the 429 would only be hiding the cost from the user.
  it('does not call the gateway once the quota is spent', async () => {
    await burn(alice.id, LIMITS.user);
    const gateway = stubGatewaySuccess();

    const res = await post(alice, '/api/ai/improve').send({ text: 'some rough notes' });

    expect(res.status).toBe(429);
    expect(gateway).not.toHaveBeenCalled();
    expect(await userCalls(alice.id)).toBe(LIMITS.user);
  });
});

describe('route wiring', () => {
  it('returns 429 with the account dimension named when the account allowance is spent', async () => {
    await burn(alice.id, LIMITS.user);
    stubGatewaySuccess();

    const res = await post(alice, '/api/ai/improve').send({ text: 'some rough notes' });

    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({
      reason: 'quota_exceeded',
      blockedBy: 'user',
      used: LIMITS.user,
      limit: LIMITS.user,
    });
    expect(typeof res.body.resetAt).toBe('string');
    expect(new Date(res.body.resetAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('returns 429 with the ip dimension named when the network allowance is spent', async () => {
    for (let i = 0; i < LIMITS.ip; i++) {
      const sharer = await makeUser(app);
      await recordUsage(sharer.id, IP);
    }
    stubGatewaySuccess();

    const res = await post(alice, '/api/ai/improve').send({ text: 'some rough notes' });

    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ reason: 'quota_exceeded', blockedBy: 'ip', limit: LIMITS.ip });
    expect(res.body.error).toMatch(/network/i);
  });

  // The account routes are registered before the gate on purpose. An exhausted user is
  // exactly the user who needs to read their usage and save a key, so gating these would
  // lock the door and hide the handle. A regression in the mount order would only surface
  // for users already at their limit, which is nobody's local development state.
  it('still serves GET /usage when the user is over quota', async () => {
    await burn(alice.id, LIMITS.user);

    const res = await get(alice, '/api/ai/usage');

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ used: LIMITS.user, remaining: 0 });
    expect(res.body.usingOwnKey).toBe(false);
    expect(typeof res.body.resetAt).toBe('string');
  });

  it('still accepts PUT /key when the user is over quota', async () => {
    await burn(alice.id, LIMITS.user);

    const res = await put(alice, '/api/ai/key').send({ apiKey: KEY });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ present: true, hint: '6789' });
  });

  it('still accepts DELETE /key when the user is over quota', async () => {
    await setUserKey(alice.id, KEY);
    await burn(alice.id, LIMITS.user);

    const res = await del(alice, '/api/ai/key');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ present: false });
    await expect(getUserKey(alice.id)).resolves.toBeNull();
  });

  it('requires a session on every ai route, gated or not', async () => {
    const calls = [
      request(app).get('/api/ai/usage'),
      request(app).put('/api/ai/key').send({ apiKey: KEY }),
      request(app).delete('/api/ai/key'),
      request(app).post('/api/ai/improve').send({ text: 'some rough notes' }),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.status).toBe(401);
    }
  });

  // The server is what dereferences a stored base URL, so a non-http scheme would be the
  // server reading a file: or similar on the user's behalf.
  it('rejects a non-http baseUrl', async () => {
    const res = await put(alice, '/api/ai/key').send({ apiKey: KEY, baseUrl: 'file:///etc/passwd' });

    expect(res.status).toBe(400);
    await expect(getKeyHint(alice.id)).resolves.toMatchObject({ present: false });
  });

  it('rejects an unparseable baseUrl', async () => {
    const res = await put(alice, '/api/ai/key').send({ apiKey: KEY, baseUrl: 'not a url' });
    expect(res.status).toBe(400);
  });

  it('rejects an over-long key', async () => {
    const res = await put(alice, '/api/ai/key').send({ apiKey: 'k'.repeat(513) });

    expect(res.status).toBe(400);
    await expect(getKeyHint(alice.id)).resolves.toMatchObject({ present: false });
  });

  it('rejects a missing key', async () => {
    const res = await put(alice, '/api/ai/key').send({});
    expect(res.status).toBe(400);
  });

  it('stores a custom endpoint with its trailing slash trimmed', async () => {
    const res = await put(alice, '/api/ai/key').send({ apiKey: KEY, baseUrl: 'https://gw.example.com/v1/' });

    expect(res.status).toBe(200);
    expect(res.body.baseUrl).toBe('https://gw.example.com/v1');
  });
});

/** Flip one byte of a base64 column so it stays well-formed base64 but no longer authenticates. */
function tamper(b64: string): string {
  const buf = Buffer.from(b64, 'base64');
  buf[0] ^= 0xff;
  return buf.toString('base64');
}

async function tamperColumn(uid: string, column: 'ciphertext' | 'iv' | 'auth_tag'): Promise<void> {
  const row = await db.prepare(`SELECT ${column} AS v FROM ai_keys WHERE user_id = ?`).get<{ v: string }>(uid);
  await db.prepare(`UPDATE ai_keys SET ${column} = ? WHERE user_id = ?`).run(tamper(row!.v), uid);
}

describe('bring your own key', () => {
  it('round-trips a key through encryption', async () => {
    await setUserKey(alice.id, KEY, 'https://gw.example.com/v1');
    await expect(getUserKey(alice.id)).resolves.toEqual({ apiKey: KEY, baseUrl: 'https://gw.example.com/v1' });
  });

  it('returns null for a user with no key saved', async () => {
    await expect(getUserKey(alice.id)).resolves.toBeNull();
    await expect(getKeyHint(alice.id)).resolves.toEqual({ present: false, hint: '', baseUrl: null });
  });

  // The row is the thing that leaks in a database compromise, so no column in it may carry
  // the key, in the clear or base64-wrapped.
  it('stores no recoverable copy of the key in the row', async () => {
    await setUserKey(alice.id, KEY);
    const row = await db
      .prepare('SELECT base_url, ciphertext, iv, auth_tag, hint FROM ai_keys WHERE user_id = ?')
      .get<Record<string, string | null>>(alice.id);

    expect(row?.ciphertext).toBeTruthy();
    expect(row?.ciphertext).not.toContain(KEY);
    expect(Buffer.from(row!.ciphertext!, 'base64').toString('utf8')).not.toContain(KEY);
    expect(JSON.stringify(row)).not.toContain(KEY);
  });

  it('uses a fresh iv for every write, so the same key never encrypts to the same bytes', async () => {
    await setUserKey(alice.id, KEY);
    const first = await db.prepare('SELECT ciphertext, iv FROM ai_keys WHERE user_id = ?').get<{ ciphertext: string; iv: string }>(alice.id);
    await setUserKey(alice.id, KEY);
    const second = await db.prepare('SELECT ciphertext, iv FROM ai_keys WHERE user_id = ?').get<{ ciphertext: string; iv: string }>(alice.id);

    // Reusing an IV under one key is the single mistake that breaks GCM outright.
    expect(second?.iv).not.toBe(first?.iv);
    expect(second?.ciphertext).not.toBe(first?.ciphertext);
    await expect(getUserKey(alice.id)).resolves.toMatchObject({ apiKey: KEY });
  });

  // The authentication tag is the reason GCM was chosen over a bare stream cipher: a row
  // edited in the database must fail closed. Null is the right failure because it sends the
  // user back to the shared pool; wrong plaintext would ship a garbage credential to the
  // provider, and a throw would 500 every AI request until they re-entered a key by hand.
  it.each(['ciphertext', 'iv', 'auth_tag'] as const)(
    'returns null rather than wrong plaintext when %s has been tampered with',
    async (column) => {
      await setUserKey(alice.id, KEY);
      await tamperColumn(alice.id, column);

      await expect(getUserKey(alice.id)).resolves.toBeNull();
    },
  );

  it('exposes only the last four characters as a hint', async () => {
    await setUserKey(alice.id, KEY);
    const hint = await getKeyHint(alice.id);

    expect(hint).toEqual({ present: true, hint: KEY.slice(-4), baseUrl: null });
    expect(hint.hint.length).toBe(4);
    // A short key would otherwise be published in full by its own hint.
    expect(hintFor('abc')).toBe('****');
    expect(hintFor('abcd')).toBe('****');
  });

  it('deletes the key', async () => {
    await setUserKey(alice.id, KEY);
    await deleteUserKey(alice.id);

    await expect(getUserKey(alice.id)).resolves.toBeNull();
    await expect(getKeyHint(alice.id)).resolves.toMatchObject({ present: false, hint: '' });
  });

  // The whole point of the feature. A user paying their own provider is not spending the
  // operator's pool, so the quota must not apply to them and their calls must not be
  // counted. If this regresses the escape hatch stops working for exactly the people who
  // bought it, and the counters start attributing someone else's spend to the shared pool.
  it('does not meter a user who has saved their own key', async () => {
    await burn(alice.id, LIMITS.user);
    await expect(checkQuota(alice.id, IP)).resolves.toMatchObject({ allowed: false, blockedBy: 'user' });

    await setUserKey(alice.id, KEY);
    const gateway = stubGatewaySuccess();
    const res = await post(alice, '/api/ai/improve').send({ text: 'some rough notes' });

    expect(res.status).toBe(200);
    // Exactly the calls burn() recorded, so the completion above added nothing.
    expect(await userCalls(alice.id)).toBe(LIMITS.user);
    expect(await ipCalls()).toBe(LIMITS.user);

    // And it was billed to their credential, not the operator's.
    const init = gateway.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
  });

  it('sends a saved custom endpoint to the gateway instead of the operator default', async () => {
    await setUserKey(alice.id, KEY, 'https://gw.example.com/v1');
    const gateway = stubGatewaySuccess();

    const res = await post(alice, '/api/ai/improve').send({ text: 'some rough notes' });

    expect(res.status).toBe(200);
    expect(String(gateway.mock.calls[0]?.[0])).toBe('https://gw.example.com/v1/chat/completions');
  });

  it('reports the key on GET /usage so the settings screen can show which one is saved', async () => {
    await setUserKey(alice.id, KEY);

    const res = await get(alice, '/api/ai/usage');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ usingOwnKey: true, keyHint: '6789' });
    expect(JSON.stringify(res.body)).not.toContain(KEY);
  });

  // Deleting the key puts the user back on the pool, including back under a ceiling they
  // had already reached. Otherwise "add a key, use it, remove it" would be a way to reset
  // the counter.
  it('returns a user to the shared pool and its spent quota when the key is deleted', async () => {
    await burn(alice.id, LIMITS.user);
    await setUserKey(alice.id, KEY);
    await deleteUserKey(alice.id);
    stubGatewaySuccess();

    const res = await post(alice, '/api/ai/improve').send({ text: 'some rough notes' });

    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ blockedBy: 'user' });
  });
});
