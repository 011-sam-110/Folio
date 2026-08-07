// POST /api/ai/suggest - the review run.
//
// The property these tests exist to hold on to is the fan-out: ONE model request per enabled
// check family, issued in parallel. Six to eight related checks per prompt is inside what a
// model reads carefully; all 56 in one prompt buys shallow coverage of all 56. Collapsing the
// run into a single call would be cheaper, would keep every other assertion here passing, and
// would quietly gut the feature - so the call count and the per-family scoping are asserted
// directly rather than inferred from the response.
//
// The model is mocked at the `fetch` seam, the same way every other AI suite here does it.
// That keeps the real chat()/complete()/recordUsage path in play, which is what makes the
// quota assertions below mean anything: they are counting rows the production code wrote.

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';

// vi.hoisted runs before the imports below, which is the only window that matters: config.ts
// reads each of these once at module load and freezes it.
const LIMITS = vi.hoisted(() => {
  // Small enough that a test can exhaust an allowance in a few calls.
  process.env.FOLIO_AI_FREE_MONTHLY_USER = '6';
  process.env.FOLIO_AI_FREE_MONTHLY_IP = '60';
  // ONE model in the chain, so "how many requests did this run issue?" has an exact answer.
  // With the production three-model chain, a family that fails costs three fetches and the
  // call-count assertions would be counting the fallback chain instead of the fan-out.
  process.env.FOLIO_AI_TEXT_MODELS = 'test-model';
  // chat() sleeps this long before re-running a chain that was entirely rate-limited.
  process.env.FOLIO_AI_RATELIMIT_RETRY_MS = '0';
  process.env.FOLIO_AI_KEK = 'test-only-key-encryption-key';
  return { user: 6, ip: 60 };
});

import { buildApp } from '../src/app.js';
import { db, pool } from '../src/db.js';
import { recordUsage } from '../src/ai/usage.js';
import { setUserKey } from '../src/ai/keys.js';
import { resetDatabase, resetData, makeUser, closeDatabase, insertNotebook, insertNote, type TestUser } from './helpers.js';

const app = buildApp();

/** Explicit forwarded address, so the IP dimension of the quota is a subject the test controls. */
const IP = '203.0.113.44';

const HEADING_ID = 'blk-heading';
const PARA_ID = 'blk-para';

/**
 * A note as the editor saves it: every block carrying the TipTap UniqueID the review
 * anchors to. An import writes `content_json` without ids (they are minted client-side), and
 * the "no ids" case below is about exactly that note.
 */
const DOC_WITH_IDS = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { id: HEADING_ID, level: 2 }, content: [{ type: 'text', text: 'Deadlock' }] },
    {
      type: 'paragraph',
      attrs: { id: PARA_ID },
      content: [{ type: 'text', text: 'Requests wait in a queue until the resource is free.' }],
    },
  ],
};

const DOC_WITHOUT_IDS = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Requests wait in a queue.' }] }],
};

let alice: TestUser;
let notebookId: string;
let noteId: string;

beforeAll(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetData();
  // ai_usage deliberately has no foreign key (its scope='ip' rows key on a hashed address),
  // so nothing cascades to it and its counters would otherwise leak into the next test.
  await pool.query('DELETE FROM ai_usage');
  alice = await makeUser(app);
  notebookId = await insertNotebook(alice.id);
  noteId = await insertNote(alice.id, notebookId, {
    title: 'Deadlock',
    content_json: JSON.stringify(DOC_WITH_IDS),
    content_text: 'Deadlock\nRequests wait in a queue until the resource is free.',
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await closeDatabase();
});

function suggest(user: TestUser, body: Record<string, unknown>) {
  return user.agent.post('/api/ai/suggest').set('X-Forwarded-For', IP).send(body);
}

/** A check belonging to each family the tests below use, so a reply is scoped to its request. */
const CHECK_FOR: Record<string, string> = {
  accuracy: 'accuracy.units',
  clarity: 'clarity.ambiguous-pronoun',
  grammar: 'grammar.spelling',
  structure: 'structure.wall-of-text',
};

/** A well-formed edit for `checkId`, overridable field by field. */
function edit(checkId: string, over: Record<string, unknown> = {}) {
  return {
    id: 'e1',
    blockId: PARA_ID,
    op: 'replace',
    before: 'a queue',
    after: 'a FIFO queue',
    reason: 'Your notes distinguish FIFO from priority queues, so name which one this is.',
    checkId,
    ...over,
  };
}

/**
 * A gateway that answers each family request from `reply`, keyed by the family the prompt
 * names. The `FAMILY:` marker line in the system prompt is what identifies a request - every
 * request in a run is otherwise nearly identical.
 */
function stubModel(
  reply: (family: string) => unknown,
  opts: { fail?: string[]; garbage?: string[] } = {},
) {
  const seen: string[] = [];
  const f = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    const family = String(body.messages[0].content).match(/^FAMILY: (\S+)$/m)?.[1] ?? '';
    seen.push(family);
    if (opts.fail?.includes(family)) return new Response('upstream exploded', { status: 500 });
    // 200 with a body that is not the agreed shape - the dominant real-world failure, and a
    // different code path from a transport error.
    const content = opts.garbage?.includes(family) ? 'Sure! Here are some ideas.' : JSON.stringify(reply(family));
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', f);
  return { fetch: f, seen, bodies: () => f.mock.calls.map(c => JSON.parse(String((c[1] as RequestInit).body))) };
}

/** Calls charged to one account this period. */
async function userCalls(uid: string): Promise<number> {
  const row = await db
    .prepare("SELECT calls FROM ai_usage WHERE scope = 'user' AND subject = ?")
    .get<{ calls: number }>(uid);
  return Number(row?.calls ?? 0);
}

describe('one model request per family', () => {
  it('issues exactly one request per requested family, and no more', async () => {
    const { seen } = stubModel(family => ({ edits: [edit(family === 'grammar' ? 'grammar.spelling' : 'accuracy.units')] }));

    const res = await suggest(alice, { noteId, families: ['accuracy', 'grammar'] });

    expect(res.status).toBe(200);
    expect(seen.sort()).toEqual(['accuracy', 'grammar']);
    expect(res.body.ranFamilies).toEqual(['accuracy', 'grammar']);
  });

  it('merges the edits from every family into one flat array', async () => {
    stubModel(family => ({ edits: [edit(CHECK_FOR[family])] }));

    const res = await suggest(alice, { noteId, families: ['accuracy', 'clarity', 'grammar'] });

    expect(res.body.edits).toHaveLength(3);
    expect(res.body.edits.map((e: { checkId: string }) => e.checkId).sort()).toEqual(
      ['accuracy.units', 'clarity.ambiguous-pronoun', 'grammar.spelling'],
    );
    expect(res.body.rejected).toBe(0);
  });

  // The reason ranFamilies exists. Free-tier gateways throttle in bursts, so one family
  // failing is the common case, and throwing away the other seven would be the worst possible
  // answer to it.
  it('keeps the rest of the run when one family request fails', async () => {
    stubModel(family => ({ edits: [edit(CHECK_FOR[family])] }), { fail: ['grammar'] });

    const res = await suggest(alice, { noteId, families: ['accuracy', 'grammar', 'clarity'] });

    expect(res.status).toBe(200);
    expect(res.body.ranFamilies).toEqual(['accuracy', 'clarity']);
    expect(res.body.ranFamilies).not.toContain('grammar');
    expect(res.body.edits).toHaveLength(2);
  });

  // A family whose completion could not be parsed has NOT been checked. Reporting it as a
  // clean pass would present the model's failure to the student as reassurance.
  it('leaves a family out of ranFamilies when its completion cannot be read', async () => {
    stubModel(() => ({ edits: [edit('accuracy.units')] }), { garbage: ['clarity'] });

    const res = await suggest(alice, { noteId, families: ['accuracy', 'clarity'] });

    expect(res.body.ranFamilies).toEqual(['accuracy']);
    expect(res.body.edits).toHaveLength(1);
  });

  it('answers with an empty run rather than an error when every family fails', async () => {
    stubModel(() => ({ edits: [] }), { fail: ['accuracy', 'grammar'] });

    const res = await suggest(alice, { noteId, families: ['accuracy', 'grammar'] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ edits: [], rejected: 0, ranFamilies: [] });
  });
});

describe('what comes back from the model', () => {
  it('sends the note as blocks tagged with the ids the editor anchors by', async () => {
    const { bodies } = stubModel(() => ({ edits: [] }));

    await suggest(alice, { noteId, families: ['accuracy'] });

    const user = String(bodies()[0].messages[1].content);
    expect(user).toContain(`<block id="${HEADING_ID}" type="heading">`);
    expect(user).toContain(`<block id="${PARA_ID}" type="paragraph">`);
    expect(user).toContain('Requests wait in a queue until the resource is free.');
  });

  it('drops an edit with a blank reason and counts it as rejected', async () => {
    stubModel(() => ({
      edits: [edit('accuracy.units'), edit('accuracy.units', { id: 'e2', reason: '   ' })],
    }));

    const res = await suggest(alice, { noteId, families: ['accuracy'] });

    expect(res.body.edits).toHaveLength(1);
    expect(res.body.rejected).toBe(1);
  });

  // Each request names one family and is told to ignore everything else. An edit citing
  // another family's check would make ranFamilies a lie - Grammar would look checked because
  // an Accuracy request mentioned a typo - and would double-report whatever Grammar's own
  // request found.
  it('drops an edit that names a check from a family this request was not for', async () => {
    stubModel(() => ({ edits: [edit('grammar.spelling')] }));

    const res = await suggest(alice, { noteId, families: ['accuracy'] });

    expect(res.body.edits).toEqual([]);
    expect(res.body.rejected).toBe(1);
    expect(res.body.ranFamilies).toEqual(['accuracy']);
  });

  // Every family's completion is happy to call its first edit "e1". The client keys
  // approve/deny by id, so a collision means clicking one card applies a different card's
  // edit to the note.
  it('keeps edit ids unique across families that both returned the same id', async () => {
    stubModel(family => ({
      edits: [edit(family === 'grammar' ? 'grammar.spelling' : 'accuracy.units', { id: 'e1' })],
    }));

    const res = await suggest(alice, { noteId, families: ['accuracy', 'grammar'] });

    const ids = res.body.edits.map((e: { id: string }) => e.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('quota is priced by family count', () => {
  // The gate authorises the request; the run then spends one call per family behind it. If
  // this regressed to one charge per run, eight families would cost the shared pool eight
  // calls and record one.
  it('charges one call per family, not one per run', async () => {
    stubModel(() => ({ edits: [] }));

    await suggest(alice, { noteId, families: ['accuracy', 'clarity', 'grammar'] });

    expect(await userCalls(alice.id)).toBe(3);
  });

  // The other half of pricing by family count: a user with two calls left must not be able to
  // spend eight. Trimmed rather than refused, and ranFamilies reports which families the
  // allowance actually paid for.
  it('runs only as many families as the remaining allowance can pay for', async () => {
    for (let i = 0; i < LIMITS.user - 2; i++) await recordUsage(alice.id, IP);
    const { seen } = stubModel(() => ({ edits: [] }));

    const res = await suggest(alice, { noteId, families: ['accuracy', 'clarity', 'grammar', 'structure'] });

    expect(res.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(res.body.ranFamilies).toEqual(['accuracy', 'clarity']);
    expect(await userCalls(alice.id)).toBe(LIMITS.user);
  });

  it('does not trim a user paying with their own key', async () => {
    await setUserKey(alice.id, 'sk-test-abcdef0123456789', 'https://gw.example.com/v1');
    for (let i = 0; i < LIMITS.user; i++) await recordUsage(alice.id, IP);
    const { seen } = stubModel(() => ({ edits: [] }));

    const res = await suggest(alice, { noteId, families: ['accuracy', 'clarity', 'grammar', 'structure'] });

    expect(res.status).toBe(200);
    expect(seen).toHaveLength(4);
    // Their calls are billed to their credential, so the shared counter did not move.
    expect(await userCalls(alice.id)).toBe(LIMITS.user);
  });
});

describe('what it refuses', () => {
  it('requires a noteId and at least one known family', async () => {
    const { fetch: gateway } = stubModel(() => ({ edits: [] }));

    expect((await suggest(alice, { families: ['accuracy'] })).status).toBe(400);
    expect((await suggest(alice, { noteId })).status).toBe(400);
    expect((await suggest(alice, { noteId, families: [] })).status).toBe(400);
    expect((await suggest(alice, { noteId, families: ['made-up-family'] })).status).toBe(400);
    expect(gateway).not.toHaveBeenCalled();
  });

  // A stale client is a client that has not reloaded since a family was deprecated. Refusing
  // the seven families it got right over the one it did not helps nobody.
  it('ignores an unknown family when a known one is alongside it', async () => {
    stubModel(() => ({ edits: [] }));

    const res = await suggest(alice, { noteId, families: ['made-up-family', 'accuracy', 'accuracy'] });

    expect(res.status).toBe(200);
    expect(res.body.ranFamilies).toEqual(['accuracy']);
  });

  it('404s for an unknown note and for another account note', async () => {
    const bob = await makeUser(app);
    expect((await suggest(alice, { noteId: 'nope', families: ['accuracy'] })).status).toBe(404);
    expect((await suggest(bob, { noteId, families: ['accuracy'] })).status).toBe(404);
  });

  it('404s for a soft-deleted note', async () => {
    await db.prepare('UPDATE notes SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), noteId);
    expect((await suggest(alice, { noteId, families: ['accuracy'] })).status).toBe(404);
  });

  // Two different 400s on purpose. A note full of writing whose blocks have no ids has simply
  // never been open in the editor since it was imported, and telling that user "there is
  // nothing to review" would be flatly untrue about their note.
  it('refuses a note whose blocks carry no editor ids, without spending a call', async () => {
    const { fetch: gateway } = stubModel(() => ({ edits: [] }));
    const imported = await insertNote(alice.id, notebookId, {
      content_json: JSON.stringify(DOC_WITHOUT_IDS),
      content_text: 'Requests wait in a queue.',
    });

    const res = await suggest(alice, { noteId: imported, families: ['accuracy'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/open this note/i);
    expect(gateway).not.toHaveBeenCalled();
  });

  it('refuses an empty note in its own words', async () => {
    const empty = await insertNote(alice.id, notebookId, {
      content_json: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] }),
      content_text: '',
    });

    const res = await suggest(alice, { noteId: empty, families: ['accuracy'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/nothing in this note/i);
  });

  it('requires a session', async () => {
    const res = await request(app).post('/api/ai/suggest').send({ noteId, families: ['accuracy'] });
    expect(res.status).toBe(401);
  });
});
