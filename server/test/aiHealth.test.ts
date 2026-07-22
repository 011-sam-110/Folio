// Whether AI is *available* - the signal every AI affordance in the web app hides itself on.
//
// The bug this file exists for: `/api/meta/ai-health` probed the operator's shared gateway
// and nothing else, so a user who had saved their own working provider key was still told
// AI was offline and every AI control stayed hidden. The health answer has to describe the
// credential the caller would actually use, not the one the operator configured.

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';

const ENV = vi.hoisted(() => {
  process.env.FOLIO_AI_KEK = 'test-only-key-encryption-key';
  process.env.FOLIO_AI_RATELIMIT_RETRY_MS = '0';
  // The production default, and the whole point: a Vercel function has no localhost:3001.
  process.env.FOLIO_AI_BASE_URL = 'http://localhost:3001/v1';
  process.env.FOLIO_AI_KEY = 'operator-shared-key';
  return { shared: 'http://localhost:3001/v1' };
});

import { buildApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { setUserKey } from '../src/ai/keys.js';
import { _resetAiHealthCache, sharedPoolCreds, userKeyCreds, credentialProblem } from '../src/ai/client.js';
import { resetDatabase, resetData, makeUser, closeDatabase, type TestUser } from './helpers.js';

const app = buildApp();

const USER_KEY = 'sk-user-owned-key-0001';
const USER_ENDPOINT = 'https://gw.example.com/v1';

let alice: TestUser;

beforeAll(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetData();
  await pool.query('DELETE FROM ai_usage');
  _resetAiHealthCache();
  alice = await makeUser(app);
});

afterEach(() => {
  vi.unstubAllGlobals();
  _resetAiHealthCache();
});

afterAll(async () => {
  await closeDatabase();
});

/**
 * A gateway that only answers at `reachable`. Everything else fails at connect time, which
 * is what `http://localhost:3001/v1` does inside a serverless function.
 */
function stubGateway(reachable: string, content = 'OK') {
  const f = vi.fn(async (url: unknown) => {
    if (!String(url).startsWith(reachable)) throw new TypeError('fetch failed');
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', f);
  return f;
}

describe('GET /api/meta/ai-health', () => {
  it('reports the shared pool as unreachable when the operator gateway is dead', async () => {
    stubGateway('https://nothing-here.example');

    const res = await alice.agent.get('/api/meta/ai-health');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.source).toBe('shared-pool');
    // Not just a boolean: the UI has to be able to say WHY.
    expect(typeof res.body.error).toBe('string');
    expect(typeof res.body.hint).toBe('string');
  });

  // The regression. Before the fix this answered `ok: false` because the probe used the
  // operator's dead gateway regardless of what the caller had saved.
  it('reports OK for a user whose own key and endpoint work, even though the shared gateway does not', async () => {
    await setUserKey(alice.id, USER_KEY, USER_ENDPOINT);
    const gateway = stubGateway(USER_ENDPOINT);

    const res = await alice.agent.get('/api/meta/ai-health');

    expect(res.body).toMatchObject({ ok: true, source: 'own-key' });
    expect(String(gateway.mock.calls[0]?.[0])).toBe(`${USER_ENDPOINT}/chat/completions`);
    const init = gateway.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${USER_KEY}`);
    expect(JSON.stringify(res.body)).not.toContain(USER_KEY);
  });

  // One cache for everybody would hand Bob the answer computed for Alice's private
  // endpoint - both directions are wrong, and the "AI is fine" direction is the one that
  // renders controls that then fail.
  it('does not serve one user a health answer computed for another user credential', async () => {
    const bob = await makeUser(app);
    await setUserKey(alice.id, USER_KEY, USER_ENDPOINT);
    stubGateway(USER_ENDPOINT);

    await expect(alice.agent.get('/api/meta/ai-health').then(r => r.body.ok)).resolves.toBe(true);
    await expect(bob.agent.get('/api/meta/ai-health').then(r => r.body.ok)).resolves.toBe(false);
  });

  it('reports a broken personal key as the user own problem, not the shared pool', async () => {
    await setUserKey(alice.id, USER_KEY, 'https://wrong.example.com/v1');
    stubGateway(USER_ENDPOINT);

    const res = await alice.agent.get('/api/meta/ai-health');

    expect(res.body).toMatchObject({ ok: false, source: 'own-key', reason: 'unreachable' });
    expect(res.body.hint).toMatch(/AI settings/i);
  });

  it('requires a session', async () => {
    const res = await (await import('supertest')).default(app).get('/api/meta/ai-health');
    expect(res.status).toBe(401);
  });
});

describe('configuration problems are named, not probed', () => {
  // A loopback gateway address cannot work on a serverless host, so spending a real
  // completion to discover that is both slow and pointless - and the resulting message
  // ("fetch failed") sends the reader looking for an outage instead of a missing env var.
  it('calls out a loopback base URL on a serverless host without calling the gateway', () => {
    const problem = credentialProblem(sharedPoolCreds(), 'shared-pool', true);

    expect(problem?.reason).toBe('not_configured');
    expect(problem?.error).toContain(ENV.shared);
    expect(problem?.hint).toMatch(/FOLIO_AI_BASE_URL/);
  });

  it('accepts the same loopback base URL when not serverless', () => {
    expect(credentialProblem(sharedPoolCreds(), 'shared-pool', false)).toBeNull();
  });

  it('names a missing operator key', () => {
    const problem = credentialProblem({ ...sharedPoolCreds(), apiKey: '' }, 'shared-pool', false);
    expect(problem?.reason).toBe('not_configured');
    expect(problem?.hint).toMatch(/FOLIO_AI_KEY/);
  });

  // The design gap, made visible. A bare personal key inherits the operator's base URL;
  // in production that is the unreachable localhost default, so the user has done
  // everything the settings screen asked and still gets nothing.
  it('tells a user with a key but no endpoint that the fallback address is the problem', () => {
    const problem = credentialProblem(userKeyCreds(USER_KEY, null), 'own-key', true);

    expect(problem?.reason).toBe('not_configured');
    expect(problem?.hint).toMatch(/endpoint/i);
  });

  it('is happy with a personal key pointed at a public endpoint', () => {
    expect(credentialProblem(userKeyCreds(USER_KEY, USER_ENDPOINT), 'own-key', true)).toBeNull();
  });
});

describe('a personal key can pin its own models', () => {
  // client.ts always documented this ("a custom endpoint is a different service whose model
  // names we cannot guess, so the caller supplies those") but nothing implemented it: a
  // personal OpenAI key at api.openai.com was still called with `gemini-2.5-flash`.
  it('uses saved models instead of the operator chain', () => {
    const creds = userKeyCreds(USER_KEY, USER_ENDPOINT, ['gpt-4o-mini']);
    expect(creds.textModels).toEqual(['gpt-4o-mini']);
    expect(creds.visionModels).toEqual(['gpt-4o-mini']);
  });

  it('falls back to the operator chain when none are saved', () => {
    const creds = userKeyCreds(USER_KEY, USER_ENDPOINT, null);
    expect(creds.textModels).toEqual(sharedPoolCreds().textModels);
  });

  it('round-trips models through the key store and out to the gateway', async () => {
    await setUserKey(alice.id, USER_KEY, USER_ENDPOINT, ['gpt-4o-mini']);
    const gateway = stubGateway(USER_ENDPOINT);

    const res = await alice.agent.get('/api/meta/ai-health');

    expect(res.body.ok).toBe(true);
    const init = gateway.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(init?.body)).model).toBe('gpt-4o-mini');
  });
});

describe('PUT /api/ai/key verifies what it just saved', () => {
  // The reported symptom was "I entered a key and nothing turned on". Saving silently and
  // leaving the user to guess is what made that invisible - the save has to answer.
  it('returns a health verdict alongside the saved key', async () => {
    stubGateway(USER_ENDPOINT);

    const res = await alice.agent
      .put('/api/ai/key')
      .send({ apiKey: USER_KEY, baseUrl: USER_ENDPOINT, models: 'gpt-4o-mini' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ present: true, models: ['gpt-4o-mini'] });
    expect(res.body.health).toMatchObject({ ok: true, source: 'own-key' });
    expect(JSON.stringify(res.body)).not.toContain(USER_KEY);
  });

  it('saves the key but reports the failure when the endpoint does not answer', async () => {
    stubGateway('https://somewhere-else.example');

    const res = await alice.agent
      .put('/api/ai/key')
      .send({ apiKey: USER_KEY, baseUrl: USER_ENDPOINT });

    expect(res.status).toBe(200);
    expect(res.body.present).toBe(true);
    expect(res.body.health).toMatchObject({ ok: false, source: 'own-key' });
    expect(typeof res.body.health.error).toBe('string');
  });

  it('rejects too many models', async () => {
    const res = await alice.agent
      .put('/api/ai/key')
      .send({ apiKey: USER_KEY, baseUrl: USER_ENDPOINT, models: 'a,b,c,d,e,f,g' });
    expect(res.status).toBe(400);
  });

  // Deleting the key puts the user back on the shared pool, and the health answer has to
  // follow - otherwise the app keeps showing AI as available on a credential that is gone.
  it('reports the shared pool again after the key is deleted', async () => {
    await setUserKey(alice.id, USER_KEY, USER_ENDPOINT);
    stubGateway(USER_ENDPOINT);
    await expect(alice.agent.get('/api/meta/ai-health').then(r => r.body.source)).resolves.toBe('own-key');

    await alice.agent.delete('/api/ai/key');

    const res = await alice.agent.get('/api/meta/ai-health');
    expect(res.body.source).toBe('shared-pool');
    expect(res.body.ok).toBe(false);
  });
});
